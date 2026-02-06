import { App, GenericMessageEvent } from '@slack/bolt';
import { ClaudeClient } from '../llm/client.js';
import { Orchestrator } from '../orchestrator/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSpawnSubagentTool } from '../tools/spawn-subagent.js';
import { createCheckTasksTool } from '../tools/check-tasks.js';
import { searchMemoryTool } from '../tools/search-memory.js';
import { updateKnowledgeTool } from '../tools/update-knowledge.js';
import { getProjectContextTool } from '../tools/get-project-context.js';
import { ConversationStore } from '../conversations/store.js';
import { needsCompaction, compactConversation } from '../conversations/compact.js';
import { loadKnowledge } from '../memory/knowledge.js';
import { indexMessages } from '../memory/indexer.js';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AssistantMessage, Message } from '@mariozechner/pi-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// File-based log since console.error doesn't flush reliably inside Bolt event handlers
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync('/tmp/cletus.log', line);
}

/**
 * Extract text content from a conversation's new messages for indexing.
 * Only indexes the latest user message and assistant response.
 */
function extractIndexEntries(
  userMessage: string,
  messages: Message[],
): Array<{ role: string; content: string }> {
  const entries: Array<{ role: string; content: string }> = [];

  // Index the user message
  if (userMessage.trim()) {
    entries.push({ role: 'user', content: userMessage });
  }

  // Find the last assistant message and extract its text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const assistant = msg as AssistantMessage;
      const text = assistant.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.trim()) {
        entries.push({ role: 'assistant', content: text });
      }
      break;
    }
  }

  return entries;
}

export function setupMessageHandler(app: App, claude: ClaudeClient, orchestrator: Orchestrator) {
  // Cache system prompt at registration time — no reason to read disk per message
  const systemPromptPath = join(__dirname, '../../config/system-prompt.md');
  const baseSystemPrompt = readFileSync(systemPromptPath, 'utf-8');

  // Load CLI tools config for system prompt
  const cliToolsPath = join(__dirname, '../../config/cli-tools.json');
  let cliToolsPrompt = '';
  if (existsSync(cliToolsPath)) {
    try {
      const cliTools = JSON.parse(readFileSync(cliToolsPath, 'utf-8'));
      const lines = Object.entries(cliTools).map(([name, info]: [string, any]) => {
        const status = info.available ? 'available' : 'not available';
        const note = info.note ? ` (${info.note})` : '';
        const extra = info.project ? ` — project: ${info.project}` : '';
        return `- ${name}: ${status}${note}${extra}`;
      });
      cliToolsPrompt = `\n\n## Available CLI Tools\n\n${lines.join('\n')}`;
    } catch {}
  }

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

      const tools = ToolRegistry.forOrchestrator([
        spawnTool,
        checkTasksTool,
        searchMemoryTool,
        updateKnowledgeTool,
        getProjectContextTool,
      ]);

      // Load knowledge base and build full system prompt
      const knowledge = loadKnowledge();
      let systemPrompt = baseSystemPrompt;
      if (knowledge.trim()) {
        systemPrompt += `\n\n## Knowledge Base\n\n${knowledge}`;
      }
      systemPrompt += cliToolsPrompt;

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

      // Index the new messages for memory search (async, don't block response)
      const indexEntries = extractIndexEntries(userMessage, response.messages);
      if (indexEntries.length > 0) {
        indexMessages('conversation', channelId, indexEntries).catch((err) => {
          log(`Indexing failed for channel ${channelId}: ${err?.message || err}`);
        });
      }

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
