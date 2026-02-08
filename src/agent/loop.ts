/**
 * Agent loop — while(tool_call) -> execute -> feed results -> repeat
 *
 * The model is the planner. No state machines.
 * When the model stops calling tools, the task is done.
 */

import {
  completeSimple,
  type Model,
  type Message,
  type AssistantMessage,
  type ToolCall,
  type TextContent,
  type ImageContent,
} from '@mariozechner/pi-ai';
import { toolRegistry, ToolRegistry } from '../tools/registry.js';

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

const MAX_ITERATIONS = 50;
const API_TIMEOUT_MS = 120_000; // 2 minutes per API call

export interface AgentLoopOptions {
  apiKey: string;
  model: Model;
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
        text: 'Stopped.',
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
      const steerContent: string | (TextContent | ImageContent)[] = steerBefore.attachments?.length
        ? [{ type: 'text' as const, text: steerBefore.message }, ...steerBefore.attachments]
        : steerBefore.message;
      messages.push({ role: 'user', content: steerContent, timestamp: Date.now() });
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
          const steerContent: string | (TextContent | ImageContent)[] = steerMsg.attachments?.length
            ? [{ type: 'text' as const, text: steerMsg.message }, ...steerMsg.attachments]
            : steerMsg.message;
          messages.push({ role: 'user', content: steerContent, timestamp: Date.now() });
          options.steer?.onSteer?.(steerMsg.message);
          continue; // Restart loop iteration with steered message
        }
        // Not a steer — must be timeout
        throw new Error('Claude API call timed out after 2 minutes');
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

    // Aborted mid-request
    if (response.stopReason === 'aborted' || options.signal?.aborted) {
      return {
        text: 'Stopped.',
        iterations,
        toolCalls: totalToolCalls,
        stopped: true,
        messages,
        usage,
      };
    }

    // No more tool calls — extract final text
    if (response.stopReason === 'stop' || response.stopReason === 'length') {
      const text = response.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('');

      messages.push(response);
      return {
        text: text || 'Task completed.',
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
      const textBlocks = response.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('');
      if (textBlocks.trim()) {
        await options.onIntermediateText(textBlocks);
      }
    }

    if (callBlocks.length === 0) {
      const text = response.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('');

      messages.push(response);
      return {
        text: text || 'Task completed.',
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
        text: 'Stopped.',
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

      try {
        const result = await tool.execute(toolCall.arguments);
        return {
          role: 'toolResult' as const,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text' as const, text: result.success ? result.output! : `Error: ${result.error}` }],
          isError: !result.success,
          timestamp: Date.now(),
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          role: 'toolResult' as const,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text' as const, text: `Error executing tool: ${msg}` }],
          isError: true,
          timestamp: Date.now(),
        };
      }
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

    // Check for steer after tool execution
    const steerAfterTools = options.steer?.consume();
    if (steerAfterTools) {
      const steerContent: string | (TextContent | ImageContent)[] = steerAfterTools.attachments?.length
        ? [{ type: 'text' as const, text: steerAfterTools.message }, ...steerAfterTools.attachments]
        : steerAfterTools.message;
      messages.push({ role: 'user', content: steerContent, timestamp: Date.now() });
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
