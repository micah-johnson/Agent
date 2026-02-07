/**
 * Background process tool — manage long-running processes (dev servers, builds, watchers).
 *
 * Wraps the ProcessManager singleton with a single tool that supports
 * start/list/stop/logs/check actions.
 */

import type { Tool, ToolInput, ToolResult } from './types.js';
import { getProcessManager } from '../processes/manager.js';

export const backgroundProcessTool: Tool = {
  name: 'background_process',
  description:
    'Manage background processes (dev servers, builds, watchers, etc.). Start long-running commands that persist across tool calls. Active processes are automatically shown in your context.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action to perform',
        enum: ['start', 'list', 'stop', 'logs', 'check'],
      },
      command: {
        type: 'string',
        description: 'Shell command to run (for start action)',
      },
      working_directory: {
        type: 'string',
        description: 'Working directory for the command (for start action)',
      },
      label: {
        type: 'string',
        description: 'Human-friendly label for the process (for start action)',
      },
      id: {
        type: 'string',
        description: 'Process ID (for stop, logs, check actions)',
      },
      tail: {
        type: 'number',
        description: 'Number of log lines to return (for logs action, default 100)',
      },
    },
    required: ['action'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const pm = getProcessManager();
    const action = input.action as string;

    switch (action) {
      case 'start': {
        const command = input.command as string | undefined;
        if (!command) {
          return { success: false, error: 'Missing required parameter: command' };
        }

        try {
          const proc = pm.start(command, {
            cwd: input.working_directory as string | undefined,
            label: input.label as string | undefined,
          });
          return {
            success: true,
            output: `Started background process ${proc.id} (PID ${proc.pid})\nLog file: ${proc.logFile}`,
            metadata: {
              id: proc.id,
              pid: proc.pid,
              logFile: proc.logFile,
            },
          };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }

      case 'list': {
        const processes = pm.list();
        if (processes.length === 0) {
          return { success: true, output: 'No background processes.' };
        }

        const lines = processes.map((p) => {
          const status = p.status === 'running' ? 'running' : `exited (${p.exitCode})`;
          const label = p.label ? ` [${p.label}]` : '';
          return `${p.id}${label}: ${p.command} (PID ${p.pid}, ${status})`;
        });

        return {
          success: true,
          output: lines.join('\n'),
          metadata: {
            count: processes.length,
            running: processes.filter((p) => p.status === 'running').length,
          },
        };
      }

      case 'stop': {
        const id = input.id as string | undefined;
        if (!id) {
          return { success: false, error: 'Missing required parameter: id' };
        }

        const result = pm.stop(id);
        if (result.success) {
          return {
            success: true,
            output: result.error || `Sent SIGTERM to ${id}. Will SIGKILL after 5s if needed.`,
          };
        }
        return { success: false, error: result.error };
      }

      case 'logs': {
        const id = input.id as string | undefined;
        if (!id) {
          return { success: false, error: 'Missing required parameter: id' };
        }

        const tail = input.tail as number | undefined;
        const result = pm.logs(id, { tail });
        if (result.success) {
          return { success: true, output: result.output };
        }
        return { success: false, error: result.error };
      }

      case 'check': {
        const id = input.id as string | undefined;
        if (!id) {
          return { success: false, error: 'Missing required parameter: id' };
        }

        const proc = pm.check(id);
        if (!proc) {
          return { success: false, error: `Process ${id} not found` };
        }

        const uptime = proc.status === 'running'
          ? `${Math.floor((Date.now() - proc.startedAt.getTime()) / 1000)}s`
          : '—';
        const status = proc.status === 'running' ? 'running' : `exited (${proc.exitCode})`;

        return {
          success: true,
          output: `${proc.id}: ${status}\nCommand: ${proc.command}\nPID: ${proc.pid}\nUptime: ${uptime}\nLog: ${proc.logFile}`,
          metadata: {
            id: proc.id,
            status: proc.status,
            exitCode: proc.exitCode,
            pid: proc.pid,
          },
        };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};
