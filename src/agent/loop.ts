/**
 * Agent loop — while(tool_call) -> execute -> feed results -> repeat
 *
 * The model is the planner. No state machines.
 * When the model stops calling tools, the task is done.
 */

import {
  completeSimple,
  type Api,
  type Model,
  type Message,
  type AssistantMessage,
  type ToolCall,
  type TextContent,
  type ImageContent,
} from '@mariozechner/pi-ai';
import { toolRegistry, ToolRegistry } from '../tools/registry.js';
import { runPreToolHooks, runPostToolHooks } from '../hooks/engine.js';

export interface ToolProgressInfo {
  name: string;
  args: Record<string, any>;
  success?: boolean;
}

export interface ProgressEvent {
  phase: 'thinking' | 'tools_start' | 'tools_done';
  iteration: number;
  tools?: ToolProgressInfo[];
}

const MAX_ITERATIONS = 100;
const API_TIMEOUT_MS = 300_000; // 5 minutes per API call

/**
 * Mid-turn context pruning — prevents context from growing unbounded during
 * long tool-calling turns. Instead of a full LLM-powered compaction (too slow
 * and expensive mid-loop), we truncate old tool results in-place, keeping the
 * most recent ones intact so the model has fresh context.
 *
 * Threshold is in estimated tokens (chars / 4). We target staying well under
 * the 200k context window.
 */
const MID_TURN_TOKEN_LIMIT = 100_000; // ~100k tokens estimated
const MID_TURN_PRESERVE_RECENT = 6;   // keep last N tool results untouched
const TOOL_RESULT_TRUNCATE_LIMIT = 300; // chars to keep from truncated results

/** Rough token estimate — ~4 chars per token for English text. */
function estimateMessageTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block) chars += block.text.length;
        }
      }
    } else if (msg.role === 'assistant') {
      for (const block of (msg as AssistantMessage).content) {
        if ('text' in block) chars += (block as any).text.length;
        if ('thinking' in block) chars += (block as any).thinking.length;
        if (block.type === 'toolCall') chars += JSON.stringify((block as ToolCall).arguments).length + 100;
      }
    } else if (msg.role === 'toolResult') {
      const tr = msg as any;
      if (tr.content) {
        for (const block of tr.content) {
          if (block.type === 'text') chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Prune old tool results in-place when context gets too large.
 * Walks backwards, skipping the most recent tool results, and truncates older ones.
 */
function pruneToolResults(messages: Message[]): void {
  const estimatedTokens = estimateMessageTokens(messages);
  if (estimatedTokens <= MID_TURN_TOKEN_LIMIT) return;

  // Collect indices of all toolResult messages
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'toolResult') {
      toolResultIndices.push(i);
    }
  }

  if (toolResultIndices.length <= MID_TURN_PRESERVE_RECENT) return;

  // Truncate older tool results (everything except the last N)
  const truncatableIndices = toolResultIndices.slice(0, -MID_TURN_PRESERVE_RECENT);
  let pruned = 0;

  for (const idx of truncatableIndices) {
    const msg = messages[idx] as any;
    if (!msg.content) continue;

    for (const block of msg.content) {
      if (block.type === 'text' && block.text.length > TOOL_RESULT_TRUNCATE_LIMIT) {
        const originalLen = block.text.length;
        const preview = block.text.substring(0, TOOL_RESULT_TRUNCATE_LIMIT);
        block.text = `${preview}\n[...truncated from ${originalLen} chars — mid-turn context limit]`;
        pruned++;
      }
    }
  }

  if (pruned > 0) {
    const newEstimate = estimateMessageTokens(messages);
    console.log(`[loop] Mid-turn prune: truncated ${pruned} old tool results (${estimatedTokens} → ${newEstimate} est. tokens)`);
  }
}

/** Sentinel value returned when the loop is aborted — not a real model response. */
export const ABORTED_SENTINEL = '__ABORTED__';

export interface AgentLoopOptions {
  apiKey: string;
  model: Model<Api>;
  systemPrompt: string;
  maxIterations?: number;
  tools?: ToolRegistry;
  history?: Message[];
  reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
  /** If provided, each tool call goes through this gate before execution. */
  approvalGate?: (toolName: string, toolArgs: Record<string, any>) => Promise<'accept' | 'always' | 'deny'>;
  /** Optional file attachments (images, text files) to include in the user message. */
  attachments?: (TextContent | ImageContent)[];
  /** Called when the model emits text alongside tool calls (for proactive responses). */
  onIntermediateText?: (text: string) => Promise<void>;
  /** Steer support — allows injecting new user messages into the running loop. */
  steer?: {
    consume: () => { message: string; attachments?: (TextContent | ImageContent)[] } | null;
    registerCallAbort: (controller: AbortController) => void;
    clearCallAbort: () => void;
    onSteer?: (message: string) => void;
  };
  /** Hook context — channel/user info for lifecycle hooks. */
  hookContext?: { channel_id: string; user_id: string };
}

export interface AgentLoopUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface AgentLoopResult {
  text: string;
  iterations: number;
  toolCalls: number;
  stopped: boolean;
  messages: Message[];
  usage: AgentLoopUsage;
}

/** Extract concatenated text from a response's content blocks. */
function extractText(content: AssistantMessage['content']): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Build steer message content — multimodal array if attachments present, plain string otherwise. */
function buildSteerContent(steer: { message: string; attachments?: (TextContent | ImageContent)[] }): string | (TextContent | ImageContent)[] {
  return steer.attachments?.length
    ? [{ type: 'text' as const, text: steer.message }, ...steer.attachments]
    : steer.message;
}

export async function runAgentLoop(
  userMessage: string,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const maxIterations = options.maxIterations || MAX_ITERATIONS;
  let iterations = 0;
  let totalToolCalls = 0;
  const usage: AgentLoopUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };

  const registry = options.tools || toolRegistry;

  // Build user message — multimodal content array if attachments present
  const userContent: string | (TextContent | ImageContent)[] =
    options.attachments?.length
      ? [
          { type: 'text' as const, text: userMessage },
          ...options.attachments,
        ]
      : userMessage;

  const messages: Message[] = [
    ...(options.history || []),
    {
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    },
  ];

  const tools = registry.toClaudeFormat();

  while (iterations < maxIterations) {
    if (options.signal?.aborted) {
      return {
        text: ABORTED_SENTINEL,
        iterations,
        toolCalls: totalToolCalls,
        stopped: true,
        messages,
        usage,
      };
    }

    iterations++;

    // Check for steer messages before making the API call
    const steerBefore = options.steer?.consume();
    if (steerBefore) {
      messages.push({ role: 'user', content: buildSteerContent(steerBefore), timestamp: Date.now() });
      options.steer?.onSteer?.(steerBefore.message);
    }

    options.onProgress?.({ phase: 'thinking', iteration: iterations });

    // Create a per-call timeout that composes with the external abort signal
    const callController = new AbortController();
    options.steer?.registerCallAbort(callController);
    const timeoutId = setTimeout(() => callController.abort(), API_TIMEOUT_MS);

    // If the external signal aborts, also abort this call
    const onExternalAbort = () => callController.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let response: AssistantMessage;
    try {
      response = await completeSimple(
        options.model,
        {
          messages,
          systemPrompt: options.systemPrompt,
          tools,
        },
        {
          apiKey: options.apiKey,
          maxTokens: 16384,
          temperature: 1.0,
          ...(options.reasoning ? { reasoning: options.reasoning } : {}),
          signal: callController.signal,
        },
      );
    } catch (err) {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onExternalAbort);
      options.steer?.clearCallAbort();

      // Full abort takes priority
      if (options.signal?.aborted) throw err;

      // Check if this was a steer abort (not a timeout)
      if (callController.signal.aborted) {
        const steerMsg = options.steer?.consume();
        if (steerMsg) {
          messages.push({ role: 'user', content: buildSteerContent(steerMsg), timestamp: Date.now() });
          options.steer?.onSteer?.(steerMsg.message);
          continue; // Restart loop iteration with steered message
        }
        // Not a steer — must be timeout
        throw new Error('Claude API call timed out after 5 minutes');
      }
      throw err;
    }

    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onExternalAbort);
    options.steer?.clearCallAbort();

    // Accumulate token usage
    if (response.usage) {
      usage.inputTokens += response.usage.input || 0;
      usage.outputTokens += response.usage.output || 0;
      usage.cacheReadTokens += response.usage.cacheRead || 0;
      usage.cacheWriteTokens += response.usage.cacheWrite || 0;
      usage.totalTokens += response.usage.totalTokens || 0;
    }

    // Aborted mid-request — check if it was a steer before giving up
    if (response.stopReason === 'aborted' || options.signal?.aborted) {
      // Full abort (stop command) takes priority
      if (options.signal?.aborted) {
        return {
          text: ABORTED_SENTINEL,
          iterations,
          toolCalls: totalToolCalls,
          stopped: true,
          messages,
          usage,
        };
      }
      // Check for steer message — if found, inject and continue the loop
      const steerMsg = options.steer?.consume();
      if (steerMsg) {
        messages.push({ role: 'user', content: buildSteerContent(steerMsg), timestamp: Date.now() });
        options.steer?.onSteer?.(steerMsg.message);
        continue;
      }
      // Not a steer — API call was interrupted (likely timeout or server error)
      const errorDetail = response.errorMessage ? `: ${response.errorMessage}` : '';
      console.log(`[loop] API call aborted mid-stream (iteration ${iterations}, ${totalToolCalls} tool calls)${errorDetail}`);
      return {
        text: `The API call was interrupted${errorDetail}. You can say "continue" to pick up where I left off.`,
        iterations,
        toolCalls: totalToolCalls,
        stopped: true,
        messages,
        usage,
      };
    }

    // No more tool calls — extract final text
    if (response.stopReason === 'stop' || response.stopReason === 'length') {
      messages.push(response);
      return {
        text: extractText(response.content) || 'Task completed.',
        iterations,
        toolCalls: totalToolCalls,
        stopped: true,
        messages,
        usage,
      };
    }

    if (response.stopReason === 'error') {
      throw new Error(`API error: ${response.errorMessage}`);
    }

    // Extract tool calls
    const callBlocks = response.content.filter(
      (block): block is ToolCall => block.type === 'toolCall',
    );

    // Surface any intermediate text (proactive responses like "On it")
    if (callBlocks.length > 0 && options.onIntermediateText) {
      const intermediateText = extractText(response.content);
      if (intermediateText.trim()) {
        await options.onIntermediateText(intermediateText);
      }
    }

    if (callBlocks.length === 0) {
      messages.push(response);
      return {
        text: extractText(response.content) || 'Task completed.',
        iterations,
        toolCalls: totalToolCalls,
        stopped: true,
        messages,
        usage,
      };
    }

    // Add assistant response to history
    messages.push(response);

    // Check abort before executing tools
    if (options.signal?.aborted) {
      return {
        text: ABORTED_SENTINEL,
        iterations,
        toolCalls: totalToolCalls,
        stopped: true,
        messages,
        usage,
      };
    }

    // Execute tool calls and feed results back
    totalToolCalls += callBlocks.length;

    options.onProgress?.({
      phase: 'tools_start',
      iteration: iterations,
      tools: callBlocks.map((tc) => ({
        name: tc.name,
        args: tc.arguments || {},
      })),
    });

    const executeTool = async (toolCall: ToolCall) => {
      // Pre-tool hook — can deny or modify tool input
      if (options.hookContext) {
        try {
          const preResult = await runPreToolHooks(toolCall.name, toolCall.arguments || {}, options.hookContext);
          if (preResult.action === 'deny') {
            return {
              role: 'toolResult' as const,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: [{ type: 'text' as const, text: `Blocked by hook: ${preResult.reason || 'no reason given'}` }],
              isError: true,
              timestamp: Date.now(),
            };
          }
          if (preResult.action === 'modify' && preResult.modified_input) {
            toolCall.arguments = preResult.modified_input;
          }
        } catch (err) {
          console.warn(`[hooks] pre_tool hook failed for "${toolCall.name}":`, err);
        }
      }

      const tool = registry.get(toolCall.name);

      if (!tool) {
        return {
          role: 'toolResult' as const,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text' as const, text: `Error: Tool '${toolCall.name}' not found` }],
          isError: true,
          timestamp: Date.now(),
        };
      }

      let toolResult;
      try {
        const result = await tool.execute(toolCall.arguments);
        toolResult = {
          role: 'toolResult' as const,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text' as const, text: result.success ? (result.output ?? '') : `Error: ${result.error}` }],
          isError: !result.success,
          timestamp: Date.now(),
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        toolResult = {
          role: 'toolResult' as const,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text' as const, text: `Error executing tool: ${msg}` }],
          isError: true,
          timestamp: Date.now(),
        };
      }

      // Post-tool hook — can inject context into tool result
      if (options.hookContext) {
        try {
          const postResult = await runPostToolHooks(
            toolCall.name,
            toolCall.arguments || {},
            toolResult,
            options.hookContext,
          );
          if (postResult.context) {
            const textBlock = toolResult.content?.find((b: any) => b.type === 'text');
            if (textBlock) {
              textBlock.text += `\n[Hook: ${postResult.context}]`;
            }
          }
        } catch (err) {
          console.warn(`[hooks] post_tool hook failed for "${toolCall.name}":`, err);
        }
      }

      return toolResult;
    };

    let toolResults;

    if (options.approvalGate) {
      // Sequential execution with approval checks
      toolResults = [];
      for (const toolCall of callBlocks) {
        if (options.signal?.aborted) {
          toolResults.push({
            role: 'toolResult' as const,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: 'text' as const, text: 'Aborted.' }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        const decision = await options.approvalGate(toolCall.name, toolCall.arguments || {});
        if (decision === 'deny') {
          toolResults.push({
            role: 'toolResult' as const,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: 'text' as const, text: 'Error: Tool call denied by user.' }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }
        // 'accept' and 'always' both execute — 'always' whitelist is handled by the gate
        toolResults.push(await executeTool(toolCall));
      }
    } else {
      // Parallel execution (default — no approval gate)
      toolResults = await Promise.all(callBlocks.map(executeTool));
    }

    options.onProgress?.({
      phase: 'tools_done',
      iteration: iterations,
      tools: callBlocks.map((tc, i) => ({
        name: tc.name,
        args: tc.arguments || {},
        success: !toolResults[i].isError,
      })),
    });

    messages.push(...toolResults);

    // Mid-turn context pruning — truncate old tool results if context is getting large
    pruneToolResults(messages);

    // Check for steer after tool execution
    const steerAfterTools = options.steer?.consume();
    if (steerAfterTools) {
      messages.push({ role: 'user', content: buildSteerContent(steerAfterTools), timestamp: Date.now() });
      options.steer?.onSteer?.(steerAfterTools.message);
      // Continue loop — next iteration will call Claude with new context
    }
  }

  return {
    text: 'Reached maximum iterations without completing the task.',
    iterations,
    toolCalls: totalToolCalls,
    stopped: false,
    messages,
    usage,
  };
}
