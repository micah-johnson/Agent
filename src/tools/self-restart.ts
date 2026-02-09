import type { Tool, ToolInput, ToolResult } from './types.js';
import { appendFileSync, writeFileSync } from 'fs';

export const RESTART_MARKER_PATH = '/tmp/agent-restart.json';

/**
 * Pending restart state. When set, the process-message flow will
 * exit the process AFTER saving the conversation — preventing data loss.
 */
let _pendingRestart: { reason: string } | null = null;

/** Check if a restart was requested (called after conversation is saved). */
export function getPendingRestart(): { reason: string } | null {
  return _pendingRestart;
}

/** Execute the pending restart (call after conversation save + finalize). */
export function executePendingRestart(): void {
  if (!_pendingRestart) return;
  const { reason } = _pendingRestart;
  console.log(`Self-restart: ${reason}`);
  // Small delay to let the final Slack message post
  setTimeout(() => process.exit(1), 1000);
}

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

      // Signal the pending restart — process-message will exit AFTER saving conversation
      _pendingRestart = { reason };

      return {
        success: true,
        output: `Restart scheduled. The conversation will be saved before restarting.`,
        metadata: { reason },
      };
    },
  };
}
