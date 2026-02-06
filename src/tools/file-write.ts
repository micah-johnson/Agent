/**
 * File write tool - create or overwrite files
 * Matches Claude Code's Write tool pattern
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Tool, ToolInput, ToolResult } from './types.js';

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Creates parent directories as needed.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const filePath = input.file_path as string;
    const content = input.content as string;

    if (!filePath) {
      return {
        success: false,
        error: 'file_path is required',
      };
    }

    if (content === undefined) {
      return {
        success: false,
        error: 'content is required',
      };
    }

    try {
      // Create parent directories if they don't exist
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Write file
      writeFileSync(filePath, content, 'utf-8');

      return {
        success: true,
        output: `File written successfully: ${filePath}`,
        metadata: {
          bytes: Buffer.byteLength(content, 'utf-8'),
          lines: content.split('\n').length,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Error writing file: ${error.message}`,
      };
    }
  },
};
