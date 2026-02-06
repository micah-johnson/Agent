/**
 * Sub-agent worker — runs a single task with scoped tools
 *
 * Sub-agents get execution tools only (no spawn_subagent).
 * Results are written to the task store on completion.
 */

import { getModel } from '@mariozechner/pi-ai';
import { runAgentLoop } from '../agent/loop.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Task } from '../tasks/store.js';

const SUB_AGENT_SYSTEM_PROMPT = `You are a task worker for Cletus, a personal AI agent.

You have been given a specific task to complete. Focus on completing it efficiently using your tools.

Guidelines:
- Complete the task as described in the prompt
- Use tools proactively — don't just describe what you would do, actually do it
- Be thorough but concise in your final response
- If the task cannot be completed, explain why clearly
- Your response will be sent back to the user, so write it as a final answer`;

export interface WorkerResult {
  text: string;
  iterations: number;
  toolCalls: number;
}

export async function runSubAgent(
  task: Task,
  apiKey: string,
): Promise<WorkerResult> {
  const tools = ToolRegistry.forSubAgent();
  const model = getModel('anthropic', task.model as any);

  const result = await runAgentLoop(task.prompt, {
    apiKey,
    model,
    systemPrompt: SUB_AGENT_SYSTEM_PROMPT,
    tools,
  });

  return {
    text: result.text,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
  };
}
