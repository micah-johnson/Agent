/**
 * File edit tool - make precise str_replace edits to existing files
 * Matches Claude Code's Edit tool pattern
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Tool, ToolInput, ToolResult } from './types.js';

export const fileEditTool: Tool = {
  name: 'file_edit',
  description: 'Edit an existing file by replacing old_string with new_string. The old_string must match exactly (including whitespace). Use replace_all to replace all occurrences.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The exact string to replace (must match exactly)',
      },
      new_string: {
        type: 'string',
        description: 'The string to replace it with',
      },
      replace_all: {
        type: 'boolean',
        description: 'If true, replace all occurrences. If false, only replace if unique. Default: false',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    if (!filePath || !oldString || newString === undefined) {
      return {
        success: false,
        error: 'file_path, old_string, and new_string are required',
      };
    }

    if (oldString === newString) {
      return {
        success: false,
        error: 'old_string and new_string must be different',
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

      // Read file
      const content = readFileSync(filePath, 'utf-8');

      // Count occurrences
      const occurrences = (content.match(new RegExp(escapeRegex(oldString), 'g')) || []).length;

      if (occurrences === 0) {
        return {
          success: false,
          error: 'old_string not found in file',
        };
      }

      if (!replaceAll && occurrences > 1) {
        return {
          success: false,
          error: `old_string appears ${occurrences} times in file. Use replace_all: true to replace all occurrences, or provide a more specific old_string.`,
        };
      }

      // Perform replacement
      let newContent: string;
      if (replaceAll) {
        newContent = content.split(oldString).join(newString);
      } else {
        newContent = content.replace(oldString, newString);
      }

      // Write file
      writeFileSync(filePath, newContent, 'utf-8');

      return {
        success: true,
        output: `File edited successfully: ${filePath}`,
        metadata: {
          occurrencesReplaced: occurrences,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Error editing file: ${error.message}`,
      };
    }
  },
};

// Helper function to escape regex special characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
