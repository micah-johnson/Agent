/**
 * Tool registry - manages available tools
 */

import type { Tool } from './types.js';
import { bashTool } from './bash.js';
import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import { grepTool } from './grep.js';

const CORE_TOOLS: Tool[] = [bashTool, fileReadTool, fileWriteTool, fileEditTool, grepTool];

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor(tools?: Tool[]) {
    const toRegister = tools || CORE_TOOLS;
    for (const tool of toRegister) {
      this.register(tool);
    }
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

  /** Sub-agents get execution tools only — no spawning */
  static forSubAgent(): ToolRegistry {
    return new ToolRegistry(CORE_TOOLS);
  }

  /** Orchestrator gets core tools + any extra tools (spawn_subagent, check_tasks) */
  static forOrchestrator(extraTools: Tool[]): ToolRegistry {
    return new ToolRegistry([...CORE_TOOLS, ...extraTools]);
  }
}

// Singleton instance (backward-compatible default)
export const toolRegistry = new ToolRegistry();
