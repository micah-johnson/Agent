/**
 * spawn_subagent tool — delegates work to a background sub-agent
 *
 * Factory pattern: createSpawnSubagentTool(orchestrator) returns a Tool
 * with channel/user context injected per-message via closure.
 *
 * Agent types:
 *   worker   — full tools, general purpose (default)
 *   explorer — read-only, research and investigation
 *   planner  — read-only, produces structured plans
 *   reviewer — read-only, code review and critique
 */

import type { Orchestrator } from '../orchestrator/index.js';
import type { Tool, ToolInput, ToolResult } from './types.js';
import type { AgentType } from '../tasks/store.js';
import { getModelSettings } from '../config/settings.js';

export interface SpawnContext {
  channel_id: string;
  user_id: string;
}

const AGENT_TYPE_DESCRIPTIONS: Record<AgentType, string> = {
  worker: 'Full tools — can read, write, execute commands, fetch web content. Use for implementation tasks.',
  explorer: 'Read-only — can read files, grep, and fetch web content. Use for research and investigation.',
  planner: 'Read-only — explores code and produces structured implementation plans. Use before complex changes.',
  reviewer: 'Read-only — reviews code for correctness, security, and style. Use for code review tasks.',
};

export function createSpawnSubagentTool(
  orchestrator: Orchestrator,
  context: SpawnContext,
): Tool {
  const subagentConfig = getModelSettings().subagent;
  return {
    name: 'spawn_subagent',
    description:
      'Spawn a background sub-agent to handle a long-running or complex task. ' +
      'The sub-agent runs independently and its results are routed back through you for synthesis. ' +
      'Use this for tasks that would take many tool calls, or when you want to run things in parallel. ' +
      'Returns a task_id immediately — use check_tasks to monitor progress.\n\n' +
      'Agent types control what tools are available:\n' +
      Object.entries(AGENT_TYPE_DESCRIPTIONS).map(([type, desc]) => `- "${type}": ${desc}`).join('\n'),
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
          description: `Model to use (default: "${subagentConfig.default}")`,
          enum: subagentConfig.options,
        },
        agent_type: {
          type: 'string',
          description:
            'Type of sub-agent to spawn. Controls available tools and behavior. ' +
            'Default: "worker" (full tools). Use "explorer" for research, "planner" for plans, "reviewer" for code review.',
          enum: ['worker', 'explorer', 'planner', 'reviewer'],
        },
      },
      required: ['title', 'prompt'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      const title = input.title as string;
      const prompt = input.prompt as string;
      const model = (input.model as string) || subagentConfig.default;
      const agentType = (input.agent_type as AgentType) || 'worker';

      const task = orchestrator.store.create({
        title,
        prompt,
        model,
        agent_type: agentType,
        channel_id: context.channel_id,
        user_id: context.user_id,
      });

      orchestrator.pool.submit(task);

      const typeLabel = agentType !== 'worker' ? `\nAgent type: ${agentType} (${AGENT_TYPE_DESCRIPTIONS[agentType]})` : '';

      return {
        success: true,
        output: `Task spawned: ${task.id}\nTitle: ${title}\nModel: ${model}${typeLabel}\nStatus: pending → running\n\nThe sub-agent is working on this in the background. When it finishes, the results will be routed back to you for synthesis.`,
      };
    },
  };
}
