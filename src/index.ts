import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
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
import { ToolRegistry } from './tools/registry.js';
import { ensureWorkspace } from './workspace/path.js';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { RESTART_MARKER_PATH } from './tools/self-restart.js';

// Catch unhandled rejections so they don't silently kill the process
process.on('unhandledRejection', (error) => {
  console.error('[agent] Unhandled rejection:', error);
});

/**
 * Shared pipeline for fire-and-forget agent runs (scheduler jobs, restart-resume).
 * Acquires the channel lock, creates progress/abort/steer plumbing, calls processMessage,
 * and handles finalize/abort/cleanup.
 */
async function runAgentPipeline(opts: {
  channelId: string;
  userId: string;
  message: string;
  client: WebClient;
  claude: ClaudeClient;
  orchestrator: Orchestrator;
  label: string;
}): Promise<void> {
  const { channelId, userId, message, client, claude, orchestrator, label } = opts;
  const { processMessage, log } = await import('./slack/process-message.js');
  const { ProgressUpdater } = await import('./slack/progress.js');

  orchestrator.withChannelLock(channelId, async () => {
    const signal = orchestrator.createAbortSignal(channelId);
    const progressRef = { current: new ProgressUpdater(channelId, client) };
    orchestrator.setActiveProgress(channelId, progressRef.current);
    try {
      progressRef.current.postInitial();

      const steer = {
        consume: () => orchestrator.consumeSteer(channelId),
        registerCallAbort: (controller: AbortController) =>
          orchestrator.registerCallAbort(channelId, controller),
        clearCallAbort: () => orchestrator.clearCallAbort(channelId),
        onSteer: (_message: string) => {
          const oldProgress = progressRef.current;
          oldProgress.dismiss().catch(() => {});
          const newProgress = new ProgressUpdater(channelId, client);
          newProgress.postInitial();
          progressRef.current = newProgress;
          orchestrator.setActiveProgress(channelId, newProgress);
        },
      };

      const result = await processMessage(
        channelId,
        userId,
        message,
        client,
        claude,
        orchestrator,
        (event) => progressRef.current.onProgress(event),
        (ts, blocks) => progressRef.current.adoptMessage(ts, blocks),
        signal,
        undefined,
        () => progressRef.current.getMessageTs(),
        steer,
        (text) => progressRef.current.showIntermediateText(text),
      );

      if (!signal.aborted) {
        await progressRef.current.finalize(result.text, result.toolCalls, result.usage);
      }
    } catch (err: any) {
      if (!signal.aborted) {
        log(`[${label}] Failed: ${err?.message || err}`);
        await progressRef.current.abort(`${label} failed.`);
      }
    } finally {
      orchestrator.clearAbortSignal(channelId);
    }
  });
}

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

  // Load custom tools from data/tools/
  try {
    const customCount = await ToolRegistry.loadCustomTools();
    if (customCount > 0) {
      const names = ToolRegistry.getCustomTools().map(t => t.name).join(', ');
      console.log(`✓ Custom tools: ${customCount} loaded (${names})`);
    } else {
      console.log('✓ Custom tools: none found in data/tools/');
    }
  } catch (err: any) {
    console.error(`⚠️  Custom tools error: ${err?.message || err}`);
  }

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
    console.log(`[scheduler] Job fired: ${job.name} (${job.id})`);
    runAgentPipeline({
      channelId: job.channel_id,
      userId: job.user_id,
      message: `[Scheduled task: "${job.name}"]\n${job.message}`,
      client: app.client,
      claude,
      orchestrator,
      label: `Scheduled task "${job.name}"`,
    });
  });
  console.log('✓ Scheduler started');

  // Start the app
  console.log('  Connecting to Slack...');
  await app.start();
  console.log('✓ Slack app started (Socket Mode)');

  // Warmup: verify Slack connection is live before accepting messages
  try {
    const authResult = await app.client.auth.test();
    if (authResult.user_id) {
      const { setBotUserId } = await import('./slack/handler.js');
      setBotUserId(authResult.user_id as string);
    }
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

      const reasonNote = marker.reason && marker.reason !== 'No reason specified'
        ? ` Reason: ${marker.reason}`
        : '';
      const syntheticMessage = `[Restart resume]${reasonNote}\nYou just restarted successfully. Resume the conversation — check context for what you were doing before the restart and continue if there's pending work, otherwise just confirm you're back.`;

      // Fire through the shared agent pipeline (async, don't block startup)
      runAgentPipeline({
        channelId: marker.channel_id,
        userId: marker.user_id || 'system',
        message: syntheticMessage,
        client: app.client,
        claude,
        orchestrator,
        label: 'Restart resume',
      });
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
