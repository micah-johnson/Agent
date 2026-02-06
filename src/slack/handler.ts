import { App, GenericMessageEvent } from '@slack/bolt';
import { ClaudeClient } from '../llm/client.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function setupMessageHandler(app: App, claude: ClaudeClient) {
  // Cache system prompt at registration time — no reason to read disk per message
  const systemPromptPath = join(__dirname, '../../config/system-prompt.md');
  const systemPrompt = readFileSync(systemPromptPath, 'utf-8');

  app.event('message', async ({ event, say, client }) => {
    const messageEvent = event as GenericMessageEvent;

    // Ignore bot messages to prevent loops
    if (messageEvent.subtype === 'bot_message' || messageEvent.bot_id) {
      return;
    }

    // Only respond to DMs
    if (messageEvent.channel_type !== 'im') {
      return;
    }

    const channelId = messageEvent.channel;
    const userMessage = messageEvent.text || '';
    const messageTs = messageEvent.ts;

    try {
      // React with 👀 to show we're working
      await client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      });

      // Call Claude with retry — first call after startup can fail due to OAuth token staleness
      let response;
      try {
        response = await claude.sendMessageWithTools(userMessage, systemPrompt);
      } catch (firstError) {
        console.error('[cletus] First attempt failed, retrying:', firstError);
        response = await claude.sendMessageWithTools(userMessage, systemPrompt);
      }

      // Remove 👀 when done
      await client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      });

      await say(response.text?.trim() || 'Task completed.');
    } catch (error) {
      console.error('[cletus] Error handling message:', error);

      // Remove the 👀 reaction if it exists
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: messageTs,
          name: 'eyes',
        });
      } catch {}

      await say('Sorry, something went wrong processing your message.');
    }
  });

  console.log('✓ Message handler registered');
}
