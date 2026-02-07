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

  const messages: Message[] = [
    ...(options.history || []),
    {
      role: 'user',
      content: userMessage,
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

    options.onProgress?.({ phase: 'thinking', iteration: iterations });

    const response: AssistantMessage = await completeSimple(
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
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

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

    // Execute tool calls in parallel and feed results back
    totalToolCalls += callBlocks.length;

    options.onProgress?.({
      phase: 'tools_start',
      iteration: iterations,
      tools: callBlocks.map((tc) => ({
        name: tc.name,
        args: tc.arguments || {},
      })),
    });

    const toolResults = await Promise.all(
      callBlocks.map(async (toolCall) => {
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
      }),
    );

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
