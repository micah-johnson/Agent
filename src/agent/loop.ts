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

const MAX_ITERATIONS = 50;

export interface AgentLoopOptions {
  apiKey: string;
  model: Model;
  systemPrompt: string;
  maxIterations?: number;
  tools?: ToolRegistry;
  history?: Message[];
}

export interface AgentLoopResult {
  text: string;
  iterations: number;
  toolCalls: number;
  stopped: boolean;
  messages: Message[];
}

export async function runAgentLoop(
  userMessage: string,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const maxIterations = options.maxIterations || MAX_ITERATIONS;
  let iterations = 0;
  let totalToolCalls = 0;

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
    iterations++;

    const response: AssistantMessage = await completeSimple(
      options.model,
      {
        messages,
        systemPrompt: options.systemPrompt,
        tools,
      },
      {
        apiKey: options.apiKey,
        maxTokens: 4096,
        temperature: 1.0,
      },
    );

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
      };
    }

    // Add assistant response to history
    messages.push(response);

    // Execute each tool call and feed results back
    for (const toolCall of callBlocks) {
      totalToolCalls++;

      const tool = registry.get(toolCall.name);

      if (!tool) {
        messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: `Error: Tool '${toolCall.name}' not found` }],
          isError: true,
          timestamp: Date.now(),
        });
        continue;
      }

      try {
        const result = await tool.execute(toolCall.arguments);
        messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: result.success ? result.output! : `Error: ${result.error}` }],
          isError: !result.success,
          timestamp: Date.now(),
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: 'text', text: `Error executing tool: ${msg}` }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
  }

  return {
    text: 'Reached maximum iterations without completing the task.',
    iterations,
    toolCalls: totalToolCalls,
    stopped: false,
    messages,
  };
}
