import type { Tool, ToolInput, ToolResult } from './types.js';
import { appendFileSync, writeFileSync } from 'fs';

export const RESTART_MARKER_PATH = '/tmp/agent-restart.json';

/**
 * Create a factory so we can inject channel_id at registration time.
 */
export function createSelfRestartTool(context: { channel_id: string; user_id?: string }): Tool {
  return {
    name: 'self_restart',
    description:
      'Restart the Agent process to pick up code changes or recover from issues. The systemd service will automatically restart the process. After restart, the agent will post a resume message to this channel.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional reason for the restart (for logging purposes)',
        },
      },
      required: [],
    },
    async execute(input: ToolInput): Promise<ToolResult> {
      const reason = (input.reason as string) || 'No reason specified';
      const timestamp = new Date().toISOString();

      // Log the restart to /tmp/agent.log
      const logMessage = `[${timestamp}] Agent restart requested. Reason: ${reason}\n`;
      try {
        appendFileSync('/tmp/agent.log', logMessage);
      } catch (err) {
        console.error('Failed to write to /tmp/agent.log:', err);
      }

      // Write restart marker so we can resume after restart
      try {
        writeFileSync(
          RESTART_MARKER_PATH,
          JSON.stringify({
            channel_id: context.channel_id,
            user_id: context.user_id,
            reason,
            timestamp,
          }),
        );
      } catch (err) {
        console.error('Failed to write restart marker:', err);
      }

      // Schedule the exit after 2 seconds (gives time for response to be sent)
      setTimeout(() => {
        console.log(`Self-restart: ${reason}`);
        process.exit(1);
      }, 2000);

      return {
        success: true,
        output: `Restarting in 2 seconds... I'll message you when I'm back.`,
        metadata: {
          reason,
          restart_in_ms: 2000,
        },
      };
    },
  };
}
