import { App, GenericMessageEvent } from '@slack/bolt';
import { ClaudeClient } from '../llm/client.js';
import { Orchestrator } from '../orchestrator/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSpawnSubagentTool } from '../tools/spawn-subagent.js';
import { createCheckTasksTool } from '../tools/check-tasks.js';
import { ConversationStore } from '../conversations/store.js';
import { needsCompaction, compactConversation } from '../conversations/compact.js';
import { readFileSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// File-based log since console.error doesn't flush reliably inside Bolt event handlers
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync('/tmp/cletus.log', line);
}

export function setupMessageHandler(app: App, claude: ClaudeClient, orchestrator: Orchestrator) {
  // Cache system prompt at registration time — no reason to read disk per message
  const systemPromptPath = join(__dirname, '../../config/system-prompt.md');
  const systemPrompt = readFileSync(systemPromptPath, 'utf-8');

  const checkTasksTool = createCheckTasksTool(orchestrator);
  const conversationStore = new ConversationStore();

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
    const userId = messageEvent.user;
    const userMessage = messageEvent.text || '';
    const messageTs = messageEvent.ts;

    log(`Received: "${userMessage}" from ${userId}`);

    try {
      // React with 👀 to show we're working
      await client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      });

      // Create per-message spawn tool with channel/user context
      const spawnTool = createSpawnSubagentTool(orchestrator, {
        channel_id: channelId,
        user_id: userId,
      });

      const tools = ToolRegistry.forOrchestrator([spawnTool, checkTasksTool]);
      const history = conversationStore.load(channelId);

      // Call Claude with retry
      log(`Processing: "${userMessage}" (history: ${history.length} messages)`);
      let response;
      try {
        response = await claude.sendMessageWithTools(userMessage, systemPrompt, tools, history);
      } catch (firstError: any) {
        log(`First attempt failed: ${firstError?.message || firstError}`);
        response = await claude.sendMessageWithTools(userMessage, systemPrompt, tools, history);
      }
      log(`Response: ${response.text?.substring(0, 100)}`);

      // Persist conversation history
      conversationStore.save(channelId, response.messages);

      // Check if compaction is needed (async, don't block the response)
      if (needsCompaction(response.messages)) {
        log(`Compaction triggered for channel ${channelId}`);
        compactConversation(response.messages, claude.getApiKey())
          .then(({ messages: compacted, summary }) => {
            conversationStore.saveSummary(channelId, summary, compacted);
            log(`Compaction complete for channel ${channelId} (${summary.length} chars)`);
          })
          .catch((err) => {
            log(`Compaction failed for channel ${channelId}: ${err?.message || err}`);
          });
      }

      // Remove 👀 when done
      await client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      });

      await say(response.text?.trim() || 'Task completed.');
    } catch (error: any) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : 'no stack';
      log(`ERROR processing "${userMessage}": ${errMsg}`);
      log(`STACK: ${errStack}`);

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
