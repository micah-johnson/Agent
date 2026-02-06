/**
 * Tool registry - manages available tools
 */

import type { Tool } from './types.js';
import { bashTool } from './bash.js';
import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import { grepTool } from './grep.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    // Register core tools
    this.register(bashTool);
    this.register(fileReadTool);
    this.register(fileWriteTool);
    this.register(fileEditTool);
    this.register(grepTool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Convert tools to pi-ai format
   */
  toClaudeFormat(): any[] {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema, // pi-ai uses "parameters" not "input_schema"
    }));
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();
