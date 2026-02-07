import { App } from '@slack/bolt';
import { ClaudeClient } from './llm/client.js';
import { Orchestrator } from './orchestrator/index.js';
import { setupMessageHandler } from './slack/handler.js';
import { setupActionHandlers } from './slack/actions.js';
import { loadProjects } from './workspace/registry.js';
import { indexAllProjects } from './workspace/indexer.js';
import { startWatching, stopWatching } from './workspace/watcher.js';

// Catch unhandled rejections so they don't silently kill the process
process.on('unhandledRejection', (error) => {
  console.error('[cletus] Unhandled rejection:', error);
});

async function main() {
  console.log('🤖 Starting Cletus...\n');

  // Validate Slack environment variables
  const requiredEnvVars = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
  const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);

  if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    missingEnvVars.forEach(key => console.error(`   - ${key}`));
    process.exit(1);
  }

  // Initialize Claude client (reads ANTHROPIC_API_KEY from .env)
  const claude = new ClaudeClient();
  console.log('✓ Claude client initialized');

  // Initialize orchestrator (creates DB + task store + worker pool)
  const orchestrator = new Orchestrator(claude.getApiKey());
  console.log('✓ Orchestrator initialized');

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

  // Give orchestrator access to Slack for posting sub-agent results
  orchestrator.setSlackClient(app.client);

  // Set up message handler and action handlers
  setupMessageHandler(app, claude, orchestrator);
  setupActionHandlers(app, claude, orchestrator);

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

  console.log('\n✅ Cletus is running. Send a DM to test.\n');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
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
