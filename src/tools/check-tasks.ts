/**
 * check_tasks tool — query sub-agent task status
 *
 * Factory pattern: createCheckTasksTool(orchestrator) returns a Tool.
 */

import type { Orchestrator } from '../orchestrator/index.js';
import type { Tool, ToolInput, ToolResult } from './types.js';
import type { Task } from '../tasks/store.js';

function formatTask(task: Task): string {
  const lines = [
    `ID: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    `Model: ${task.model}`,
    `Created: ${task.created_at}`,
  ];

  if (task.started_at) lines.push(`Started: ${task.started_at}`);
  if (task.completed_at) lines.push(`Completed: ${task.completed_at}`);
  if (task.iterations) lines.push(`Iterations: ${task.iterations}, Tool calls: ${task.tool_calls}`);

  if (task.status === 'completed' && task.result) {
    const preview = task.result.length > 200
      ? task.result.substring(0, 200) + '...'
      : task.result;
    lines.push(`Result: ${preview}`);
  }

  if (task.status === 'failed' && task.error) {
    lines.push(`Error: ${task.error}`);
  }

  return lines.join('\n');
}

export function createCheckTasksTool(orchestrator: Orchestrator): Tool {
  return {
    name: 'check_tasks',
    description:
      'Check the status of background sub-agent tasks. ' +
      'Query a specific task by ID, or list recent tasks filtered by status.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Specific task ID to check (from spawn_subagent)',
        },
        status: {
          type: 'string',
          description: 'Filter by status: pending, running, completed, failed',
          enum: ['pending', 'running', 'completed', 'failed'],
        },
        limit: {
          type: 'number',
          description: 'Max number of tasks to return (default 10)',
        },
      },
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      if (input.task_id) {
        const task = orchestrator.store.get(input.task_id as string);
        if (!task) {
          return { success: false, error: `Task not found: ${input.task_id}` };
        }
        return { success: true, output: formatTask(task) };
      }

      const tasks = orchestrator.store.list({
        status: input.status as string | undefined,
        limit: (input.limit as number) || 10,
      });

      if (tasks.length === 0) {
        return { success: true, output: 'No tasks found.' };
      }

      const output = tasks.map(formatTask).join('\n\n---\n\n');
      return {
        success: true,
        output: `${tasks.length} task(s):\n\n${output}`,
      };
    },
  };
}
