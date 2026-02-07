/**
 * spawn_subagent tool — delegates work to a background sub-agent
 *
 * Factory pattern: createSpawnSubagentTool(orchestrator) returns a Tool
 * with channel/user context injected per-message via closure.
 */

import type { Orchestrator } from '../orchestrator/index.js';
import type { Tool, ToolInput, ToolResult } from './types.js';

export interface SpawnContext {
  channel_id: string;
  user_id: string;
}

export function createSpawnSubagentTool(
  orchestrator: Orchestrator,
  context: SpawnContext,
): Tool {
  return {
    name: 'spawn_subagent',
    description:
      'Spawn a background sub-agent to handle a long-running or complex task. ' +
      'The sub-agent runs independently and posts its result to Slack when done. ' +
      'Use this for tasks that would take many tool calls, or when you want to run things in parallel. ' +
      'Returns a task_id immediately — use check_tasks to monitor progress.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title describing the task (shown in status updates)',
        },
        prompt: {
          type: 'string',
          description:
            'Detailed prompt for the sub-agent. Include ALL context needed — ' +
            'the sub-agent has no conversation history. Be specific about what to do and where.',
        },
        model: {
          type: 'string',
          description:
            'Model to use: "claude-opus-4-6" (default) or "claude-sonnet-4-5" (fast, simple tasks)',
          enum: ['claude-opus-4-6', 'claude-sonnet-4-5'],
        },
      },
      required: ['title', 'prompt'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      const title = input.title as string;
      const prompt = input.prompt as string;
      const model = (input.model as string) || 'claude-opus-4-6';

      const task = orchestrator.store.create({
        title,
        prompt,
        model,
        channel_id: context.channel_id,
        user_id: context.user_id,
      });

      orchestrator.pool.submit(task);

      return {
        success: true,
        output: `Task spawned: ${task.id}\nTitle: ${title}\nModel: ${model}\nStatus: pending → running\n\nThe sub-agent is working on this in the background. Results will be posted to this DM when done.`,
      };
    },
  };
}
