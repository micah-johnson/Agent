import type { Tool, ToolInput, ToolResult } from './types.js';
import { appendFileSync } from 'fs';

export const selfRestartTool: Tool = {
  name: 'self_restart',
  description:
    'Restart the Agent process to pick up code changes or recover from issues. The systemd service will automatically restart the process.',
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
      // Log error but continue with restart anyway
      console.error('Failed to write to /tmp/agent.log:', err);
    }

    // Schedule the exit after 2 seconds (gives time for response to be sent)
    setTimeout(() => {
      console.log(`Self-restart: ${reason}`);
      // Use exit code 1 to trigger systemd restart (service has Restart=on-failure)
      process.exit(1);
    }, 2000);

    return {
      success: true,
      output: 'Restarting in 2 seconds...',
      metadata: {
        reason,
        restart_in_ms: 2000,
      },
    };
  },
};
