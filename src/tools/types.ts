/**
 * Tool interface matching Claude Code's patterns
 *
 * Tools are defined using the format Claude was trained on:
 * - str_replace for file editing
 * - bash with full output capture
 * - file_read with optional line ranges
 * - grep for codebase search
 */

export interface ToolInput {
  [key: string]: any;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, any>;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute(input: ToolInput): Promise<ToolResult>;
}

/**
 * Tool execution context
 */
export interface ToolContext {
  workingDirectory?: string;
  timeout?: number;
  userId?: string;
}
