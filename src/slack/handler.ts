import { App, GenericMessageEvent } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { ClaudeClient } from '../llm/client.js';
import { Orchestrator } from '../orchestrator/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createSpawnSubagentTool } from '../tools/spawn-subagent.js';
import { createCheckTasksTool } from '../tools/check-tasks.js';
import { searchMemoryTool } from '../tools/search-memory.js';
import { updateKnowledgeTool } from '../tools/update-knowledge.js';
import { getProjectContextTool } from '../tools/get-project-context.js';
import { createPostRichMessageTool } from '../tools/post-rich-message.js';
import { ConversationStore } from '../conversations/store.js';
import { needsCompaction, compactConversation } from '../conversations/compact.js';
import { loadKnowledge } from '../memory/knowledge.js';
import { indexMessages } from '../memory/indexer.js';
import type { AgentLoopUsage } from '../agent/loop.js';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AssistantMessage, Message } from '@mariozechner/pi-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// File-based log since console.error doesn't flush reliably inside Bolt event handlers
export function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync('/tmp/cletus.log', line);
}

// Cache system prompt at module level — no reason to read disk per message
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

const conversationStore = new ConversationStore();

/**
 * Extract text content from a conversation's new messages for indexing.
 */
function extractIndexEntries(
  userMessage: string,
  messages: Message[],
): Array<{ role: string; content: string }> {
  const entries: Array<{ role: string; content: string }> = [];

  if (userMessage.trim()) {
    entries.push({ role: 'user', content: userMessage });
  }

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

/**
 * Format a number with commas for readability.
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Build a Block Kit footer context block with message metadata.
 */
function buildFooter(durationMs: number, toolCalls: number, usage: AgentLoopUsage): any {
  const parts: string[] = [];

  const seconds = (durationMs / 1000).toFixed(1);
  parts.push(`${seconds}s`);

  if (toolCalls > 0) {
    parts.push(`${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`);
  }

  parts.push(`${formatNumber(usage.totalTokens)} tokens`);

  if (usage.cacheReadTokens > 0) {
    const totalInput = usage.inputTokens + usage.cacheReadTokens;
    const pct = Math.round((usage.cacheReadTokens / totalInput) * 100);
    parts.push(`${pct}% cached`);
  }

  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: parts.join('  ·  '),
      },
    ],
  };
}

/**
 * Wrap plain text + footer into Block Kit blocks for posting.
 */
function buildMessageBlocks(text: string, footer: any): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
    footer,
  ];
}

export interface ProcessMessageResult {
  text: string;
  toolCalls: number;
  usage: AgentLoopUsage;
}

/**
 * Shared message processing logic used by both the message event handler
 * and the action handler. Runs the full agent loop and returns the response.
 */
export async function processMessage(
  channelId: string,
  userId: string,
  userMessage: string,
  client: WebClient,
  claude: ClaudeClient,
  orchestrator: Orchestrator,
): Promise<ProcessMessageResult> {
  const checkTasksTool = createCheckTasksTool(orchestrator);

  const spawnTool = createSpawnSubagentTool(orchestrator, {
    channel_id: channelId,
    user_id: userId,
  });
  const richMessageTool = createPostRichMessageTool(client, {
    channel_id: channelId,
  });

  const tools = ToolRegistry.forOrchestrator([
    spawnTool,
    checkTasksTool,
    searchMemoryTool,
    updateKnowledgeTool,
    getProjectContextTool,
    richMessageTool,
  ]);

  const knowledge = loadKnowledge();
  let systemPrompt = baseSystemPrompt;
  if (knowledge.trim()) {
    systemPrompt += `\n\n## Knowledge Base\n\n${knowledge}`;
  }
  systemPrompt += cliToolsPrompt;

  const history = conversationStore.load(channelId);

  log(`Processing: "${userMessage}" (history: ${history.length} messages)`);
  let response;
  try {
    response = await claude.sendMessageWithTools(userMessage, systemPrompt, tools, history);
  } catch (firstError: any) {
    log(`First attempt failed: ${firstError?.message || firstError}`);
    response = await claude.sendMessageWithTools(userMessage, systemPrompt, tools, history);
  }
  log(`Response: ${response.text?.substring(0, 100)}`);

  // Persist conversation history (async, don't block response)
  queueMicrotask(() => conversationStore.save(channelId, response.messages));

  // Index for memory search (async)
  const indexEntries = extractIndexEntries(userMessage, response.messages);
  if (indexEntries.length > 0) {
    indexMessages('conversation', channelId, indexEntries).catch((err) => {
      log(`Indexing failed for channel ${channelId}: ${err?.message || err}`);
    });
  }

  // Check compaction (async)
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

  return {
    text: response.text?.trim() || 'Task completed.',
    toolCalls: response.toolCalls,
    usage: response.usage,
  };
}

export function setupMessageHandler(app: App, claude: ClaudeClient, orchestrator: Orchestrator) {
  app.event('message', async ({ event, say, client }) => {
    const messageEvent = event as GenericMessageEvent;

    // Ignore bot messages, message edits, and other subtypes
    if (messageEvent.subtype || messageEvent.bot_id) {
      return;
    }

    // Only respond to DMs with a real user
    if (messageEvent.channel_type !== 'im' || !messageEvent.user) {
      return;
    }

    const channelId = messageEvent.channel;
    const userId = messageEvent.user;
    const userMessage = messageEvent.text || '';
    const messageTs = messageEvent.ts;

    log(`Received: "${userMessage}" from ${userId}`);

    try {
      // React with 👀 (fire-and-forget)
      client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      }).catch(() => {});

      const startTime = Date.now();

      const result = await processMessage(
        channelId,
        userId,
        userMessage,
        client,
        claude,
        orchestrator,
      );

      const durationMs = Date.now() - startTime;

      // Remove 👀 (fire-and-forget)
      client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      }).catch(() => {});

      // Post as Block Kit with metadata footer
      const footer = buildFooter(durationMs, result.toolCalls, result.usage);
      const blocks = buildMessageBlocks(result.text, footer);

      await client.chat.postMessage({
        channel: channelId,
        blocks,
        text: result.text, // fallback for notifications
      });
    } catch (error: any) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : 'no stack';
      log(`ERROR processing "${userMessage}": ${errMsg}`);
      log(`STACK: ${errStack}`);

      client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      }).catch(() => {});

      await say('Sorry, something went wrong processing your message.');
    }
  });

  console.log('✓ Message handler registered');
}
