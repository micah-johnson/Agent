/**
 * Grep tool — search file contents with regex
 */

import { execFileSync } from 'child_process';
import type { Tool, ToolInput, ToolResult } from './types.js';

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search for a pattern in files using grep. Returns matching lines with file paths and line numbers.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regex pattern to search for',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in. Defaults to current directory.',
      },
      file_pattern: {
        type: 'string',
        description: 'Optional glob pattern to filter files (e.g., "*.ts", "*.{js,tsx}")',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'If true, perform case-insensitive search. Default: false',
      },
    },
    required: ['pattern'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const path = (input.path as string) || '.';
    const filePattern = input.file_pattern as string | undefined;
    const caseInsensitive = (input.case_insensitive as boolean) || false;

    if (!pattern) {
      return { success: false, error: 'pattern is required' };
    }

    try {
      // Build args array — execFileSync doesn't invoke a shell, so no injection risk
      const args = ['-rn'];
      if (caseInsensitive) args.push('-i');
      args.push('-E');
      args.push(pattern);
      if (filePattern) args.push(`--include=${filePattern}`);
      args.push(path);

      const output = execFileSync('grep', args, {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      }).trim();

      // Truncate to first 100 lines
      const lines = output.split('\n');
      const truncated = lines.length > 100
        ? lines.slice(0, 100).join('\n') + `\n... (${lines.length - 100} more lines)`
        : output;

      return { success: true, output: truncated || 'No matches found' };
    } catch (error: unknown) {
      // grep returns exit code 1 when no matches found
      if (error instanceof Error && 'status' in error && (error as any).status === 1) {
        return { success: true, output: 'No matches found' };
      }
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Grep error: ${msg}` };
    }
  },
};
