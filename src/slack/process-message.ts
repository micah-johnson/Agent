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
import { createCancelTaskTool } from '../tools/cancel-task.js';
import { searchMemoryTool } from '../tools/search-memory.js';
import { createUpdateKnowledgeTool } from '../tools/update-knowledge.js';
import { getProjectContextTool } from '../tools/get-project-context.js';
import { createPostRichMessageTool } from '../tools/post-rich-message.js';
import { createFileEditTool } from '../tools/file-edit.js';
import { createUploadFileTool } from '../tools/upload-file.js';
import { createScheduleTaskTool } from '../tools/schedule-task.js';
import { createSelfRestartTool, getPendingRestart, executePendingRestart } from '../tools/self-restart.js';
import { createCanvasTool } from '../tools/canvas.js';
import { getScheduler } from '../scheduler/index.js';
import { getProcessManager } from '../processes/manager.js';
import { MCPManager } from '../mcp/manager.js';
import { ConversationStore } from '../conversations/store.js';
import { needsCompaction, compactConversation } from '../conversations/compact.js';
import { loadKnowledge } from '../memory/knowledge.js';
import { indexMessages } from '../memory/indexer.js';
import type { AgentLoopOptions, AgentLoopUsage } from '../agent/loop.js';
import type { ProgressEvent } from './progress.js';
import type { AssistantMessage, Message, TextContent, ImageContent } from '@mariozechner/pi-ai';
import { getToolApprovalMode, isToolAlwaysAllowed } from '../config/settings.js';
import {
  requestToolApproval,
  isSessionWhitelisted,
  addToSessionWhitelist,
  type ApprovalDecision,
} from '../tools/approval.js';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { configPath } from '../workspace/path.js';
import { runResponseHook } from '../hooks/engine.js';

// File-based log since console.error doesn't flush reliably inside Bolt event handlers
export function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync('/tmp/agent.log', line);
}

// Cache system prompt at module level — no reason to read disk per message
const systemPromptFile = configPath('system-prompt.md');
const agentName = process.env.AGENT_NAME || 'Agent';
const baseSystemPrompt = readFileSync(systemPromptFile, 'utf-8')
  .replace(/\{\{AGENT_NAME\}\}/g, agentName);

// Load CLI tools config for system prompt
const cliToolsFile = configPath('cli-tools.json');
let cliToolsPrompt = '';
if (existsSync(cliToolsFile)) {
  try {
    const cliTools = JSON.parse(readFileSync(cliToolsFile, 'utf-8'));
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
  attachments?: (TextContent | ImageContent)[],
  getProgressTs?: () => string | null,
  steer?: AgentLoopOptions['steer'],
  onIntermediateText?: (text: string) => void,
  displayName?: string,
  hookContext?: { channel_id: string; user_id: string },
): Promise<ProcessMessageResult> {
  const t0 = Date.now();
  const checkTasksTool = createCheckTasksTool(orchestrator);
  const cancelTaskTool = createCancelTaskTool(orchestrator);

  const spawnTool = createSpawnSubagentTool(orchestrator, {
    channel_id: channelId,
    user_id: userId,
  });
  const richMessageTool = createPostRichMessageTool(client, {
    channel_id: channelId,
    onNewMessage: onNewRichMessage,
  });
  const fileEditTool = createFileEditTool(client, { channel_id: channelId, getThreadTs: getProgressTs });
  const uploadFileTool = createUploadFileTool(client, { channel_id: channelId });
  const scheduleTaskTool = createScheduleTaskTool(getScheduler(), {
    channel_id: channelId,
    user_id: userId,
  });
  const selfRestartTool = createSelfRestartTool({ channel_id: channelId, user_id: userId });
  const canvasTool = createCanvasTool(client, { channel_id: channelId, user_id: userId });

  const updateKnowledgeTool = createUpdateKnowledgeTool({ user_id: userId });

  const mcpTools = MCPManager.getInstance().getAllTools();
  const tools = ToolRegistry.forOrchestrator([
    spawnTool,
    checkTasksTool,
    cancelTaskTool,
    searchMemoryTool,
    updateKnowledgeTool,
    getProjectContextTool,
    richMessageTool,
    fileEditTool,
    uploadFileTool,
    scheduleTaskTool,
    selfRestartTool,
    canvasTool,
  ], mcpTools);

  const knowledge = loadKnowledge(userId, { message: userMessage });
  let systemPrompt = baseSystemPrompt;

  // Inject current timestamp for time-awareness
  const tz = process.env.TIMEZONE || 'America/Los_Angeles';
  const now = new Date();
  const timeStr = now.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  systemPrompt += `\n\n## Current Time\n\n${timeStr}`;

  if (displayName) {
    systemPrompt += `\n\nYou are chatting with **${displayName}** (Slack user ID: ${userId}).`;
  }
  if (knowledge.trim()) {
    systemPrompt += `\n\n## Knowledge Base\n\n${knowledge}`;
  }
  systemPrompt += cliToolsPrompt;

  // Inject active background process context
  const processContext = getProcessManager().getContextSummary();
  if (processContext) {
    systemPrompt += '\n\n' + processContext;
  }

  // Inject MCP server context
  if (mcpTools.length > 0) {
    const mcpStatus = MCPManager.getInstance().getStatus().filter(s => s.connected);
    const mcpLines = mcpStatus.map(s => `- **${s.server}**: ${s.tools} tools`);
    systemPrompt += `\n\n## MCP Servers\n\nConnected MCP servers (tools are prefixed \`mcp__{server}__{tool}\`):\n${mcpLines.join('\n')}`;
  }

  const history = conversationStore.load(channelId);

  // Build approval gate if user is in 'approve' mode
  const approvalMode = getToolApprovalMode(userId);
  let approvalGate: ((toolName: string, toolArgs: Record<string, any>) => Promise<ApprovalDecision>) | undefined;

  if (approvalMode === 'approve') {
    approvalGate = async (toolName: string, toolArgs: Record<string, any>): Promise<ApprovalDecision> => {
      // Settings-level always-allow (e.g. file_read, grep)
      if (isToolAlwaysAllowed(toolName)) return 'accept';
      // Session-level whitelist (from previous "Always Accept" clicks)
      if (isSessionWhitelisted(channelId, toolName)) return 'accept';

      const decision = await requestToolApproval(toolName, toolArgs, channelId, client, signal);
      if (decision === 'always') {
        addToSessionWhitelist(channelId, toolName);
      }
      return decision;
    };
  }

  log(`Processing: "${userMessage}" (history: ${history.length} messages, attachments: ${attachments?.length ?? 0}, approval: ${approvalMode}, setup: ${Date.now() - t0}ms)`);
  let response;
  try {
    response = await claude.sendMessageWithTools(userMessage, systemPrompt, tools, history, onProgress, signal, approvalGate, attachments, steer, onIntermediateText, hookContext);
  } catch (firstError: any) {
    // Don't retry if aborted
    if (signal?.aborted) throw firstError;
    log(`First attempt failed: ${firstError?.message || firstError}`);
    response = await claude.sendMessageWithTools(userMessage, systemPrompt, tools, history, onProgress, signal, approvalGate, attachments, steer, onIntermediateText, hookContext);
  }
  log(`Response: ${response.text?.substring(0, 100)}`);
  log(`Tokens: ${response.usage.inputTokens} in, ${response.usage.outputTokens} out, ${response.usage.cacheReadTokens} cache-read, ${response.usage.cacheWriteTokens} cache-write`);

  // on_response hook — can force the agent to continue
  if (hookContext) {
    try {
      const responseHookResult = await runResponseHook(response.text || '', response.toolCalls, hookContext);
      if (responseHookResult.action === 'continue') {
        log(`Response hook requested continue: ${responseHookResult.reason}`);
        const continueMessage = responseHookResult.reason || 'A hook has requested you continue working on this task.';
        // Re-run with the continue prompt as a follow-up message
        const followUp = await claude.sendMessageWithTools(
          continueMessage, systemPrompt, tools, response.messages,
          onProgress, signal, approvalGate, attachments, steer, onIntermediateText, hookContext,
        );
        // Merge usage and update response
        response = {
          ...followUp,
          toolCalls: response.toolCalls + followUp.toolCalls,
          usage: {
            inputTokens: response.usage.inputTokens + followUp.usage.inputTokens,
            outputTokens: response.usage.outputTokens + followUp.usage.outputTokens,
            cacheReadTokens: response.usage.cacheReadTokens + followUp.usage.cacheReadTokens,
            cacheWriteTokens: response.usage.cacheWriteTokens + followUp.usage.cacheWriteTokens,
            totalTokens: response.usage.totalTokens + followUp.usage.totalTokens,
          },
        };
        log(`Continue response: ${response.text?.substring(0, 100)}`);
      }
    } catch (err: any) {
      log(`Response hook error (continuing normally): ${err?.message || err}`);
    }
  }

  // Save conversation history
  conversationStore.save(channelId, response.messages);

  // Index for memory search (async)
  const indexEntries = extractIndexEntries(userMessage, response.messages);
  if (indexEntries.length > 0) {
    indexMessages('conversation', channelId, indexEntries).catch((err) => {
      log(`Indexing failed for channel ${channelId}: ${err?.message || err}`);
    });
  }

  // Check if compaction is needed and do it inline (blocking)
  if (needsCompaction(response.messages)) {
    log(`Compaction triggered for channel ${channelId}`);
    try {
      const { messages: compacted, summary } = await compactConversation(response.messages, claude.getApiKey());
      conversationStore.saveSummary(channelId, summary, compacted);
      log(`Compaction complete for channel ${channelId} (${summary.length} chars)`);
    } catch (err: any) {
      log(`Compaction failed for channel ${channelId}: ${err?.message || err}`);
    }
  }

  const result = {
    text: response.text?.trim() || 'Task completed.',
    toolCalls: response.toolCalls,
    usage: response.usage,
  };

  // Check for pending restart AFTER conversation is saved.
  // The handler will finalize the Slack message, then we exit.
  if (getPendingRestart()) {
    log(`[restart] Conversation saved. Will exit after finalize.`);
    // Defer the actual exit so the handler has time to finalize the message
    setTimeout(() => executePendingRestart(), 3000);
  }

  return result;
}
