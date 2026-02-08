/**
 * Tool registry - manages available tools
 *
 * Tools come from three sources:
 * 1. Core tools — built-in, always available (bash, file ops, web, etc.)
 * 2. Custom tools — instance-specific, loaded from data/tools/ (.json or .ts/.js)
 * 3. MCP tools — external tools from MCP servers (config/mcp-servers.json)
 */

import type { Tool } from './types.js';
import { bashTool } from './bash.js';
import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import { grepTool } from './grep.js';
import { webFetchTool } from './web-fetch.js';
import { webBrowserTool } from './web-browser.js';
import { backgroundProcessTool } from './background-process.js';

const CORE_TOOLS: Tool[] = [bashTool, fileReadTool, fileWriteTool, fileEditTool, grepTool, webFetchTool, webBrowserTool, backgroundProcessTool];

/** Custom tools loaded at startup from data/tools/ — set by initialize() */
let _customTools: Tool[] = [];

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
  static forSubAgent(mcpTools?: Tool[]): ToolRegistry {
    return new ToolRegistry([...CORE_TOOLS, ..._customTools, ...(mcpTools || [])]);
  }

  /** Orchestrator gets core tools + custom tools + MCP tools + any extra tools */
  static forOrchestrator(extraTools: Tool[], mcpTools?: Tool[]): ToolRegistry {
    return new ToolRegistry([...CORE_TOOLS, ..._customTools, ...(mcpTools || []), ...extraTools]);
  }

  /** Initialize custom tools from data/tools/. Call once at startup. */
  static async loadCustomTools(): Promise<number> {
    const { loadCustomTools } = await import('./custom-loader.js');
    _customTools = await loadCustomTools();
    return _customTools.length;
  }

  /** Get loaded custom tools (for status/debugging) */
  static getCustomTools(): Tool[] {
    return [..._customTools];
  }
}

// Singleton instance (backward-compatible default)
export const toolRegistry = new ToolRegistry();
