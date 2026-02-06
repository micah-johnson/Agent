/**
 * File read tool - read file contents with optional line ranges
 * Matches Claude Code's Read tool pattern
 */

import { readFileSync, existsSync, statSync } from 'fs';
import type { Tool, ToolInput, ToolResult } from './types.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const fileReadTool: Tool = {
  name: 'file_read',
  description: 'Read the contents of a file. Optionally specify line offset and limit to read a specific range.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed). Optional.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read. Optional.',
      },
    },
    required: ['file_path'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const filePath = input.file_path as string;
    const offset = (input.offset as number) || 1;
    const limit = input.limit as number | undefined;

    if (!filePath) {
      return {
        success: false,
        error: 'file_path is required',
      };
    }

    try {
      // Check if file exists
      if (!existsSync(filePath)) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }

      // Check file size
      const stats = statSync(filePath);
      if (stats.size > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `File too large (${stats.size} bytes). Maximum size is ${MAX_FILE_SIZE} bytes. Use offset/limit to read specific lines.`,
        };
      }

      // Read file
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Apply line range
      const startLine = Math.max(0, offset - 1); // Convert to 0-indexed
      const endLine = limit ? startLine + limit : lines.length;
      const selectedLines = lines.slice(startLine, endLine);

      // Format with line numbers (like cat -n)
      const formattedOutput = selectedLines
        .map((line, idx) => {
          const lineNum = startLine + idx + 1; // Back to 1-indexed
          return `${lineNum.toString().padStart(6)}  ${line}`;
        })
        .join('\n');

      return {
        success: true,
        output: formattedOutput,
        metadata: {
          totalLines: lines.length,
          linesRead: selectedLines.length,
          startLine: offset,
          endLine: startLine + selectedLines.length,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Error reading file: ${error.message}`,
      };
    }
  },
};
