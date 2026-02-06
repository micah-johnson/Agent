import { App } from '@slack/bolt';
import { ClaudeClient } from './llm/client.js';
import { setupMessageHandler } from './slack/handler.js';

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

  // Initialize Claude client with OAuth
  const claude = new ClaudeClient();

  // Check if we need to login
  if (!claude.isAuthenticated()) {
    console.log('⚠️  No OAuth credentials found. Starting login flow...\n');
    await claude.login();
  }

  console.log('✓ Claude client initialized');

  // Initialize Slack app with Socket Mode
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Set up message handler
  setupMessageHandler(app, claude);

  // Start the app
  await app.start();
  console.log('✓ Slack app started (Socket Mode)');
  console.log('\n✅ Cletus is running. Send a DM to test.\n');
}

// Start the bot
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
