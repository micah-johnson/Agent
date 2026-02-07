import { App } from '@slack/bolt';
import { ClaudeClient } from './llm/client.js';
import { Orchestrator } from './orchestrator/index.js';
import { setupMessageHandler } from './slack/handler.js';
import { setupActionHandlers } from './slack/actions.js';
import { loadProjects } from './workspace/registry.js';
import { indexAllProjects } from './workspace/indexer.js';
import { startWatching, stopWatching } from './workspace/watcher.js';
import { getDb } from './db/sqlite.js';
import { watchSettings, unwatchSettings, getSettings } from './config/settings.js';
import { getScheduler } from './scheduler/index.js';
import { MCPManager } from './mcp/manager.js';
import { ensureWorkspace } from './workspace/path.js';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { RESTART_MARKER_PATH } from './tools/self-restart.js';

// Catch unhandled rejections so they don't silently kill the process
process.on('unhandledRejection', (error) => {
  console.error('[agent] Unhandled rejection:', error);
});

async function main() {
  console.log('🤖 Starting Agent...\n');

  // Ensure workspace directories exist
  ensureWorkspace();

  // Validate Slack environment variables
  const requiredEnvVars = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
  const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);

  if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    missingEnvVars.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }

  // Load settings and start hot-reload watcher
  const settings = getSettings();
  watchSettings();
  console.log(`✓ Settings loaded (policy: ${settings.permissions.defaultPolicy}, ${settings.permissions.allowedUsers.length} allowed users)`);

  // Eagerly initialize SQLite + sqlite-vec so first message isn't slow
  getDb();
  console.log('✓ Database ready');

  // Initialize Claude client (reads ANTHROPIC_API_KEY from .env)
  const claude = new ClaudeClient();
  console.log('✓ Claude client initialized');

  // Initialize orchestrator (creates DB + task store + worker pool)
  const orchestrator = new Orchestrator(claude.getApiKey());
  console.log('✓ Orchestrator initialized');

  // Initialize MCP connections
  const mcpManager = MCPManager.getInstance();
  try {
    await mcpManager.initialize();
    const mcpTools = mcpManager.getAllTools();
    if (mcpTools.length > 0) {
      console.log(`✓ MCP: ${mcpTools.length} tool(s) from ${mcpManager.getStatus().filter(s => s.connected).length} server(s)`);
    } else {
      console.log('✓ MCP: no servers configured');
    }
  } catch (err: any) {
    console.error(`⚠️  MCP initialization error: ${err?.message || err}`);
  }

  // Index registered projects and start file watchers
  const projects = loadProjects();
  if (projects.length > 0) {
    console.log('✓ Indexing projects...');
    indexAllProjects();
    startWatching(projects);
    console.log('✓ Workspace indexed and watching');
  }

  // Initialize Slack app with Socket Mode
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Give orchestrator access to Slack and Claude for sub-agent result routing
  orchestrator.setSlackClient(app.client);
  orchestrator.setClaudeClient(claude);

  // Set up message handler and action handlers
  setupMessageHandler(app, claude, orchestrator);
  setupActionHandlers(app, claude, orchestrator);

  // Start the scheduler
  const scheduler = getScheduler();
  scheduler.start((job) => {
    // Fire-and-forget — each job processes independently
    (async () => {
      const { processMessage, log } = await import('./slack/process-message.js');
      const { ProgressUpdater } = await import('./slack/progress.js');

      log(`[scheduler] Job fired: ${job.name} (${job.id})`);

      orchestrator.withChannelLock(job.channel_id, async () => {
        const signal = orchestrator.createAbortSignal(job.channel_id);
        const progressRef = { current: new ProgressUpdater(job.channel_id, app.client) };
        orchestrator.setActiveProgress(job.channel_id, progressRef.current);
        try {
          progressRef.current.postInitial();

          const syntheticMessage = `[Scheduled task: "${job.name}"]\n${job.message}`;

          // Build steer callbacks
          const steer = {
            consume: () => orchestrator.consumeSteer(job.channel_id),
            registerCallAbort: (controller: AbortController) =>
              orchestrator.registerCallAbort(job.channel_id, controller),
            clearCallAbort: () => orchestrator.clearCallAbort(job.channel_id),
            onSteer: (message: string) => {
              const oldProgress = progressRef.current;
              oldProgress.abort(`Steered → _${message.substring(0, 50)}_`).catch(() => {});
              const newProgress = new ProgressUpdater(job.channel_id, app.client);
              newProgress.postInitial();
              progressRef.current = newProgress;
              orchestrator.setActiveProgress(job.channel_id, newProgress);
            },
          };

          const result = await processMessage(
            job.channel_id,
            job.user_id,
            syntheticMessage,
            app.client,
            claude,
            orchestrator,
            (event) => progressRef.current.onProgress(event),
            (ts, blocks) => progressRef.current.adoptMessage(ts, blocks),
            signal,
            undefined,
            () => progressRef.current.getMessageTs(),
            steer,
          );

          if (!signal.aborted) {
            await progressRef.current.finalize(result.text, result.toolCalls, result.usage);
          }
        } catch (err: any) {
          if (!signal.aborted) {
            const { log: errLog } = await import('./slack/process-message.js');
            errLog(`[scheduler] Job failed: ${err?.message || err}`);
            await progressRef.current.abort(`Scheduled task "${job.name}" failed.`);
          }
        } finally {
          orchestrator.clearAbortSignal(job.channel_id);
        }
      });
    })();
  });
  console.log('✓ Scheduler started');

  // Start the app
  console.log('  Connecting to Slack...');
  await app.start();
  console.log('✓ Slack app started (Socket Mode)');

  // Warmup: verify Slack connection is live before accepting messages
  try {
    await app.client.auth.test();
    console.log('✓ Slack connection verified');
  } catch (error) {
    console.error('⚠️  Slack auth test failed:', error);
  }

  // Check for restart marker — if we were restarted via self_restart, route through agent pipeline
  try {
    if (existsSync(RESTART_MARKER_PATH)) {
      const marker = JSON.parse(readFileSync(RESTART_MARKER_PATH, 'utf-8'));
      unlinkSync(RESTART_MARKER_PATH);
      console.log(`✓ Restart marker found — resuming in ${marker.channel_id}`);

      // Fire through the normal agent pipeline (async, don't block startup)
      (async () => {
        const { processMessage, log } = await import('./slack/process-message.js');
        const { ProgressUpdater } = await import('./slack/progress.js');

        const reasonNote = marker.reason && marker.reason !== 'No reason specified'
          ? ` Reason: ${marker.reason}`
          : '';
        const syntheticMessage = `[Restart resume]${reasonNote}\nYou just restarted successfully. Resume the conversation — check context for what you were doing before the restart and continue if there's pending work, otherwise just confirm you're back.`;

        orchestrator.withChannelLock(marker.channel_id, async () => {
          const signal = orchestrator.createAbortSignal(marker.channel_id);
          const progressRef = { current: new ProgressUpdater(marker.channel_id, app.client) };
          orchestrator.setActiveProgress(marker.channel_id, progressRef.current);
          try {
            progressRef.current.postInitial();

            const steer = {
              consume: () => orchestrator.consumeSteer(marker.channel_id),
              registerCallAbort: (controller: AbortController) =>
                orchestrator.registerCallAbort(marker.channel_id, controller),
              clearCallAbort: () => orchestrator.clearCallAbort(marker.channel_id),
              onSteer: (message: string) => {
                const oldProgress = progressRef.current;
                oldProgress.abort(`Steered → _${message.substring(0, 50)}_`).catch(() => {});
                const newProgress = new ProgressUpdater(marker.channel_id, app.client);
                newProgress.postInitial();
                progressRef.current = newProgress;
                orchestrator.setActiveProgress(marker.channel_id, newProgress);
              },
            };

            const result = await processMessage(
              marker.channel_id,
              marker.user_id || 'system',
              syntheticMessage,
              app.client,
              claude,
              orchestrator,
              (event) => progressRef.current.onProgress(event),
              (ts, blocks) => progressRef.current.adoptMessage(ts, blocks),
              signal,
              undefined,
              () => progressRef.current.getMessageTs(),
              steer,
            );

            if (!signal.aborted) {
              await progressRef.current.finalize(result.text, result.toolCalls, result.usage);
            }
          } catch (err: any) {
            if (!signal.aborted) {
              log(`[restart-resume] Failed: ${err?.message || err}`);
              await progressRef.current.abort('Restart resume failed.');
            }
          } finally {
            orchestrator.clearAbortSignal(marker.channel_id);
          }
        });
      })();
    }
  } catch (err) {
    console.error('⚠️  Failed to process restart marker:', err);
  }

  console.log('\n✅ Agent is running. Send a DM to test.\n');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    scheduler.stop();
    unwatchSettings();
    await mcpManager.shutdown();
    await stopWatching();
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Start the bot
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
