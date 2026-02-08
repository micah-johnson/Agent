/**
 * Custom tool loader — loads instance-specific tools from data/tools/
 *
 * Supports two formats:
 *
 * 1. **Config-driven** (.json) — simple tools defined as JSON config.
 *    Supports "command" (shell) and "http" execution types.
 *    Input values are interpolated via {{param}} placeholders.
 *
 *    Example (command):
 *    {
 *      "name": "ping_host",
 *      "description": "Ping a host",
 *      "input_schema": {
 *        "type": "object",
 *        "properties": { "host": { "type": "string" } },
 *        "required": ["host"]
 *      },
 *      "execute": {
 *        "type": "command",
 *        "command": "ping -c 3 {{host}}",
 *        "timeout": 10000
 *      }
 *    }
 *
 *    Example (http):
 *    {
 *      "name": "search_api",
 *      "description": "Search an API",
 *      "input_schema": {
 *        "type": "object",
 *        "properties": { "query": { "type": "string" } },
 *        "required": ["query"]
 *      },
 *      "execute": {
 *        "type": "http",
 *        "url": "https://api.example.com/search?q={{query}}",
 *        "method": "GET",
 *        "headers": { "Authorization": "Bearer {{env.API_KEY}}" }
 *      }
 *    }
 *
 * 2. **Script-based** (.ts / .js) — full Tool implementation.
 *    Default export must be a Tool object or an array of Tool objects.
 *
 *    Example:
 *    export default {
 *      name: 'my_tool',
 *      description: 'Does something cool',
 *      input_schema: { type: 'object', properties: { ... } },
 *      async execute(input) {
 *        return { success: true, output: 'result' };
 *      }
 *    };
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import { execSync } from 'child_process';
import { dataDir } from '../workspace/path.js';
import type { Tool, ToolInput, ToolResult } from './types.js';

const TOOLS_DIR = join(dataDir(), 'tools');

// ─── Config-driven tool types ───────────────────────────────────────

interface CommandExecute {
  type: 'command';
  command: string;
  timeout?: number; // ms, default 30000
  env?: Record<string, string>;
}

interface HttpExecute {
  type: 'http';
  url: string;
  method?: string; // default GET
  headers?: Record<string, string>;
  body?: string | Record<string, any>;
  timeout?: number; // ms, default 30000
}

interface ConfigToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: CommandExecute | HttpExecute;
  disabled?: boolean;
}

// ─── Interpolation ──────────────────────────────────────────────────

/**
 * Replace {{param}} placeholders with input values.
 * Supports {{env.VAR}} for environment variables.
 */
function interpolate(template: string, input: ToolInput): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (_match, key: string) => {
    if (key.startsWith('env.')) {
      return process.env[key.slice(4)] || '';
    }
    const val = input[key];
    if (val === undefined || val === null) return '';
    return String(val);
  });
}

/**
 * Deep-interpolate an object/string/array — replaces {{param}} in all string values.
 */
function deepInterpolate(value: any, input: ToolInput): any {
  if (typeof value === 'string') return interpolate(value, input);
  if (Array.isArray(value)) return value.map((v) => deepInterpolate(v, input));
  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepInterpolate(v, input);
    }
    return result;
  }
  return value;
}

// ─── Config tool builders ───────────────────────────────────────────

function buildCommandTool(config: ConfigToolDef): Tool {
  const exec = config.execute as CommandExecute;
  return {
    name: config.name,
    description: config.description,
    input_schema: config.input_schema,
    async execute(input: ToolInput): Promise<ToolResult> {
      const command = interpolate(exec.command, input);
      const timeout = exec.timeout || 30_000;

      // Build env: process env + config env (interpolated) + input as TOOL_INPUT_*
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (exec.env) {
        for (const [k, v] of Object.entries(exec.env)) {
          env[k] = interpolate(v, input);
        }
      }
      for (const [k, v] of Object.entries(input)) {
        if (v !== undefined && v !== null) {
          env[`TOOL_INPUT_${k.toUpperCase()}`] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
      }

      try {
        const output = execSync(command, {
          timeout,
          env,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { success: true, output: output.trim() };
      } catch (err: any) {
        const stderr = err.stderr?.toString().trim() || '';
        const stdout = err.stdout?.toString().trim() || '';
        const msg = stderr || stdout || err.message || 'Command failed';
        return { success: false, error: msg };
      }
    },
  };
}

function buildHttpTool(config: ConfigToolDef): Tool {
  const exec = config.execute as HttpExecute;
  return {
    name: config.name,
    description: config.description,
    input_schema: config.input_schema,
    async execute(input: ToolInput): Promise<ToolResult> {
      const url = interpolate(exec.url, input);
      const method = (exec.method || 'GET').toUpperCase();
      const headers = exec.headers ? deepInterpolate(exec.headers, input) : {};
      const timeout = exec.timeout || 30_000;

      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeout),
      };

      // Build body for non-GET requests
      if (exec.body && method !== 'GET') {
        if (typeof exec.body === 'string') {
          fetchOpts.body = interpolate(exec.body, input);
        } else {
          fetchOpts.body = JSON.stringify(deepInterpolate(exec.body, input));
          if (!headers['Content-Type'] && !headers['content-type']) {
            (headers as Record<string, string>)['Content-Type'] = 'application/json';
          }
        }
      }

      try {
        const response = await fetch(url, fetchOpts);
        const text = await response.text();

        if (!response.ok) {
          return {
            success: false,
            error: `HTTP ${response.status}: ${text.slice(0, 2000)}`,
          };
        }

        // Try to pretty-print JSON
        try {
          const json = JSON.parse(text);
          return { success: true, output: JSON.stringify(json, null, 2) };
        } catch {
          return { success: true, output: text.slice(0, 50_000) };
        }
      } catch (err: any) {
        return { success: false, error: `HTTP request failed: ${err?.message || err}` };
      }
    },
  };
}

function loadConfigTool(filePath: string): Tool | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const config: ConfigToolDef = JSON.parse(raw);

    if (config.disabled) return null;
    if (!config.name || !config.execute) {
      console.warn(`[custom-tools] Skipping ${filePath}: missing name or execute`);
      return null;
    }

    switch (config.execute.type) {
      case 'command':
        return buildCommandTool(config);
      case 'http':
        return buildHttpTool(config);
      default:
        console.warn(`[custom-tools] Unknown execute type in ${filePath}: ${(config.execute as any).type}`);
        return null;
    }
  } catch (err: any) {
    console.error(`[custom-tools] Failed to load config tool ${filePath}: ${err?.message || err}`);
    return null;
  }
}

// ─── Script tool loader ─────────────────────────────────────────────

async function loadScriptTool(filePath: string): Promise<Tool[]> {
  try {
    // Dynamic import works with both .ts (Bun) and .js
    const mod = await import(filePath);
    const exported = mod.default || mod;

    if (Array.isArray(exported)) {
      // File exports multiple tools
      const tools: Tool[] = [];
      for (const item of exported) {
        if (isValidTool(item)) {
          tools.push(item);
        } else {
          console.warn(`[custom-tools] Invalid tool in array from ${filePath}`);
        }
      }
      return tools;
    } else if (isValidTool(exported)) {
      return [exported];
    } else {
      console.warn(`[custom-tools] ${filePath}: default export is not a valid Tool`);
      return [];
    }
  } catch (err: any) {
    console.error(`[custom-tools] Failed to load script tool ${filePath}: ${err?.message || err}`);
    return [];
  }
}

function isValidTool(obj: any): obj is Tool {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.execute === 'function' &&
    obj.input_schema &&
    typeof obj.input_schema === 'object'
  );
}

// ─── Main loader ────────────────────────────────────────────────────

let _cached: Tool[] | null = null;

/**
 * Load all custom tools from data/tools/.
 * Results are cached — call with reload=true to re-scan.
 */
export async function loadCustomTools(reload = false): Promise<Tool[]> {
  if (_cached && !reload) return _cached;

  if (!existsSync(TOOLS_DIR)) {
    _cached = [];
    return _cached;
  }

  const files = readdirSync(TOOLS_DIR).filter((f) => {
    const ext = extname(f).toLowerCase();
    return ['.json', '.ts', '.js'].includes(ext) && !f.startsWith('_') && !f.startsWith('.');
  });

  const tools: Tool[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const filePath = join(TOOLS_DIR, file);
    const ext = extname(file).toLowerCase();

    if (ext === '.json') {
      const tool = loadConfigTool(filePath);
      if (tool) {
        if (seen.has(tool.name)) {
          console.warn(`[custom-tools] Duplicate tool name "${tool.name}" from ${file}, skipping`);
          continue;
        }
        seen.add(tool.name);
        tools.push(tool);
      }
    } else {
      const scriptTools = await loadScriptTool(filePath);
      for (const tool of scriptTools) {
        if (seen.has(tool.name)) {
          console.warn(`[custom-tools] Duplicate tool name "${tool.name}" from ${file}, skipping`);
          continue;
        }
        seen.add(tool.name);
        tools.push(tool);
      }
    }
  }

  _cached = tools;
  return tools;
}

/**
 * Clear the cached tools — useful for reload.
 */
export function clearCustomToolCache(): void {
  _cached = null;
}
