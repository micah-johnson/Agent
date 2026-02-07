/**
 * cancel_task tool — cancel a running or queued sub-agent task
 *
 * Factory pattern: createCancelTaskTool(orchestrator) returns a Tool.
 */

import type { Orchestrator } from '../orchestrator/index.js';
import type { Tool, ToolInput, ToolResult } from './types.js';

export function createCancelTaskTool(orchestrator: Orchestrator): Tool {
  return {
    name: 'cancel_task',
    description:
      'Cancel a running or queued sub-agent task. Aborts the task immediately ' +
      'and marks it as cancelled. Use check_tasks first to find the task ID.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to cancel',
        },
      },
      required: ['task_id'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      const taskId = input.task_id as string;

      const task = orchestrator.store.get(taskId);
      if (!task) {
        return { success: false, error: `Task not found: ${taskId}` };
      }

      if (task.status === 'completed' || task.status === 'failed') {
        return { success: false, error: `Task already ${task.status}` };
      }

      const cancelled = orchestrator.pool.cancelTask(taskId);
      if (cancelled) {
        return { success: true, output: `Cancelled task "${task.title}" (${taskId})` };
      }

      return { success: false, error: `Could not cancel task ${taskId} — it may have already finished` };
    },
  };
}
