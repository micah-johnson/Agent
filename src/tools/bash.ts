/**
 * Bash tool - execute shell commands with timeout and output capture
 * Matches Claude Code's bash tool pattern
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolInput, ToolResult } from './types.js';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 120000; // 2 minutes
const MAX_OUTPUT_LENGTH = 100000; // 100KB

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a bash command and return stdout/stderr. Use this for running scripts, git operations, npm commands, etc.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      working_directory: {
        type: 'string',
        description: 'Optional working directory for the command',
      },
    },
    required: ['command'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const command = input.command as string;
    const workingDirectory = input.working_directory as string | undefined;

    if (!command || command.trim() === '') {
      return {
        success: false,
        error: 'Command cannot be empty',
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDirectory || process.cwd(),
        timeout: DEFAULT_TIMEOUT,
        maxBuffer: MAX_OUTPUT_LENGTH,
        shell: '/bin/bash',
      });

      // Combine stdout and stderr, truncate if too long
      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += stderr;

      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.substring(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
      }

      return {
        success: true,
        output: output || '(command completed with no output)',
      };
    } catch (error: any) {
      // exec throws on non-zero exit code
      const errorOutput = error.stdout || error.stderr || error.message;

      return {
        success: false,
        error: errorOutput,
        metadata: {
          exitCode: error.code,
          signal: error.signal,
        },
      };
    }
  },
};
