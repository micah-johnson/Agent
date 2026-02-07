/**
 * Shared message processing logic — runs the full agent loop and returns a response.
 *
 * Extracted to its own module to avoid circular dependencies:
 * orchestrator needs to call processMessage(), but handler.ts imports from orchestrator.
 */

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
import type { ProgressEvent } from './progress.js';
import type { AssistantMessage, Message } from '@mariozechner/pi-ai';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// File-based log since console.error doesn't flush reliably inside Bolt event handlers
export function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync('/tmp/agent.log', line);
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

export interface ProcessMessageResult {
  text: string;
  toolCalls: number;
  usage: AgentLoopUsage;
}

/**
 * Runs the full agent loop for a message and returns the response.
 * Used by the message handler, action handler, and orchestrator result routing.
 */
export async function processMessage(
  channelId: string,
  userId: string,
  userMessage: string,
  client: WebClient,
  claude: ClaudeClient,
  orchestrator: Orchestrator,
  onProgress?: (event: ProgressEvent) => void,
  onNewRichMessage?: (ts: string, blocks: any[]) => void,
  signal?: AbortSignal,
): Promise<ProcessMessageResult> {
  const checkTasksTool = createCheckTasksTool(orchestrator);

  const spawnTool = createSpawnSubagentTool(orchestrator, {
    channel_id: channelId,
    user_id: userId,
  });
  const richMessageTool = createPostRichMessageTool(client, {
    channel_id: channelId,
    onNewMessage: onNewRichMessage,
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
    response = await claude.sendMessageWithTools(userMessage, systemPrompt, tools, history, onProgress, signal);
  } catch (firstError: any) {
    // Don't retry if aborted
    if (signal?.aborted) throw firstError;
    log(`First attempt failed: ${firstError?.message || firstError}`);
    response = await claude.sendMessageWithTools(userMessage, systemPrompt, tools, history, onProgress, signal);
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
