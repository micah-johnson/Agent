/**
 * MCP Client Manager — connects to MCP servers, exposes their tools
 *
 * Reads config from config/mcp-servers.json (Claude Desktop format).
 * Spawns MCP servers as child processes via stdio transport.
 * Wraps MCP tools as our Tool interface for the tool registry.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, ToolResult } from '../tools/types.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '../../config/mcp-servers.json');

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

interface MCPServersConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

interface MCPConnection {
  client: Client;
  transport: StdioClientTransport;
  serverKey: string;
  tools: Tool[];
}

export class MCPManager {
  private connections = new Map<string, MCPConnection>();
  private static instance: MCPManager | null = null;

  static getInstance(): MCPManager {
    if (!MCPManager.instance) {
      MCPManager.instance = new MCPManager();
    }
    return MCPManager.instance;
  }

  /**
   * Load config and connect to all configured MCP servers.
   * Errors on individual servers are logged but don't block others.
   */
  async initialize(): Promise<void> {
    const config = this.loadConfig();
    if (!config || Object.keys(config.mcpServers).length === 0) {
      console.log('[mcp] No MCP servers configured');
      return;
    }

    const entries = Object.entries(config.mcpServers).filter(([, cfg]) => !cfg.disabled);
    console.log(`[mcp] Connecting to ${entries.length} MCP server(s)...`);

    const results = await Promise.allSettled(
      entries.map(([key, cfg]) => this.connectServer(key, cfg)),
    );

    for (let i = 0; i < results.length; i++) {
      const [key] = entries[i];
      const result = results[i];
      if (result.status === 'fulfilled') {
        const conn = this.connections.get(key);
        console.log(`[mcp] ✓ ${key}: ${conn?.tools.length || 0} tools`);
      } else {
        console.error(`[mcp] ✗ ${key}: ${result.reason?.message || result.reason}`);
      }
    }
  }

  /**
   * Connect to a single MCP server.
   */
  private async connectServer(key: string, config: MCPServerConfig): Promise<void> {
    const client = new Client(
      { name: 'agent', version: '1.0.0' },
      { capabilities: {} },
    );

    // Merge env: inherit process env + server-specific overrides
    const env = { ...process.env, ...(config.env || {}) } as Record<string, string>;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env,
    });

    client.onerror = (err) => {
      console.error(`[mcp] ${key} error:`, err);
    };

    await client.connect(transport);

    // Discover tools
    const toolsResult = await client.listTools();
    const tools = (toolsResult.tools || []).map((mcpTool) =>
      this.wrapMCPTool(key, client, mcpTool),
    );

    this.connections.set(key, { client, transport, serverKey: key, tools });
  }

  /**
   * Wrap an MCP tool as our Tool interface.
   * Tool names are prefixed with server key to avoid collisions:
   *   github server + "create_issue" tool → "mcp__github__create_issue"
   */
  private wrapMCPTool(
    serverKey: string,
    client: Client,
    mcpTool: { name: string; description?: string; inputSchema?: any },
  ): Tool {
    const prefixedName = `mcp__${serverKey}__${mcpTool.name}`;

    return {
      name: prefixedName,
      description: `[MCP: ${serverKey}] ${mcpTool.description || mcpTool.name}`,
      input_schema: mcpTool.inputSchema || { type: 'object' as const, properties: {} },
      execute: async (input): Promise<ToolResult> => {
        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: input,
          });

          // Extract text content from MCP result
          const textParts: string[] = [];
          if (result.content && Array.isArray(result.content)) {
            for (const block of result.content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                textParts.push(block.text);
              } else if (block.type === 'image') {
                textParts.push('[image content]');
              } else if (block.type === 'resource') {
                textParts.push(`[resource: ${(block as any).resource?.uri || 'unknown'}]`);
              }
            }
          }

          const output = textParts.join('\n') || 'Tool executed successfully (no text output).';
          const isError = result.isError === true;

          return {
            success: !isError,
            output: isError ? undefined : output,
            error: isError ? output : undefined,
          };
        } catch (err: any) {
          return {
            success: false,
            error: `MCP tool error (${serverKey}/${mcpTool.name}): ${err?.message || err}`,
          };
        }
      },
    };
  }

  /**
   * Get all tools from all connected MCP servers.
   */
  getAllTools(): Tool[] {
    const tools: Tool[] = [];
    for (const conn of this.connections.values()) {
      tools.push(...conn.tools);
    }
    return tools;
  }

  /**
   * Get tools from a specific server.
   */
  getServerTools(serverKey: string): Tool[] {
    return this.connections.get(serverKey)?.tools || [];
  }

  /**
   * List connected servers and their tool counts.
   */
  getStatus(): { server: string; tools: number; connected: boolean }[] {
    const config = this.loadConfig();
    const statuses: { server: string; tools: number; connected: boolean }[] = [];

    if (config) {
      for (const key of Object.keys(config.mcpServers)) {
        const conn = this.connections.get(key);
        statuses.push({
          server: key,
          tools: conn?.tools.length || 0,
          connected: !!conn,
        });
      }
    }

    return statuses;
  }

  /**
   * Reconnect a specific server (useful if it crashed).
   */
  async reconnectServer(serverKey: string): Promise<void> {
    const config = this.loadConfig();
    const serverConfig = config?.mcpServers[serverKey];
    if (!serverConfig) {
      throw new Error(`No config found for MCP server: ${serverKey}`);
    }

    // Disconnect if currently connected
    await this.disconnectServer(serverKey);

    // Reconnect
    await this.connectServer(serverKey, serverConfig);
    const conn = this.connections.get(serverKey);
    console.log(`[mcp] Reconnected ${serverKey}: ${conn?.tools.length || 0} tools`);
  }

  /**
   * Disconnect a specific server.
   */
  async disconnectServer(serverKey: string): Promise<void> {
    const conn = this.connections.get(serverKey);
    if (conn) {
      try {
        await conn.client.close();
      } catch (err) {
        // Ignore close errors
      }
      this.connections.delete(serverKey);
    }
  }

  /**
   * Shutdown all MCP connections.
   */
  async shutdown(): Promise<void> {
    console.log('[mcp] Shutting down MCP connections...');
    const closePromises = Array.from(this.connections.keys()).map((key) =>
      this.disconnectServer(key),
    );
    await Promise.allSettled(closePromises);
    this.connections.clear();
    console.log('[mcp] All MCP connections closed');
  }

  /**
   * Load the MCP servers config file.
   */
  private loadConfig(): MCPServersConfig | null {
    if (!existsSync(CONFIG_PATH)) {
      return null;
    }
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      return JSON.parse(raw);
    } catch (err: any) {
      console.error(`[mcp] Failed to parse config: ${err?.message || err}`);
      return null;
    }
  }
}
