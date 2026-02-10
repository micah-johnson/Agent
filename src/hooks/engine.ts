/**
 * Hook loading and execution engine.
 *
 * Loads hooks config from $WORKSPACE/config/hooks.json (cached at module level).
 * Runs shell commands with JSON on stdin, reads JSON from stdout.
 *
 * Design principles:
 * - Fail-open: hook failures NEVER break the agent
 * - Config is optional: no hooks.json → no-op
 * - Multiple matching hooks run sequentially (order matters for pre_tool)
 * - Exit code 0 → parse stdout as JSON
 * - Exit code 2 → blocking error, stderr fed back to model
 * - Other exit codes → non-blocking, continue normally
 */

import { readFileSync, existsSync } from 'fs';
import { configPath } from '../workspace/path.js';
import type { HookConfig, HooksConfig, HookEvent } from './types.js';

const HOOKS_PATH = configPath('hooks.json');
const DEFAULT_TIMEOUT = 5000;

let _config: HooksConfig | null = null;
let _loaded = false;

function loadConfig(): HooksConfig | null {
  if (_loaded) return _config;
  _loaded = true;

  if (!existsSync(HOOKS_PATH)) return null;

  try {
    const raw = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'));
    _config = raw;
    console.log('✓ Hooks config loaded');
    return _config;
  } catch (err) {
    console.error(`[hooks] Failed to parse ${HOOKS_PATH}:`, err);
    return null;
  }
}

/** Force-reload hooks config from disk (for testing / hot reload). */
export function reloadHooks(): void {
  _loaded = false;
  _config = null;
  loadConfig();
}

function getHooksForEvent(event: HookEvent): HookConfig[] {
  const config = loadConfig();
  if (!config?.hooks) return [];
  return (config.hooks[event] || []).filter(h => h.enabled !== false);
}

function matchesFilter(hook: HookConfig, toolName?: string): boolean {
  if (!hook.matcher) return true;   // No filter = match all
  if (!toolName) return true;
  try {
    return new RegExp(hook.matcher).test(toolName);
  } catch {
    return false;  // Invalid regex = skip
  }
}

async function executeHook(
  hook: HookConfig,
  payload: object,
): Promise<{ output: any; exitCode: number; stderr: string }> {
  const timeout = hook.timeout || DEFAULT_TIMEOUT;
  const input = JSON.stringify(payload);

  const proc = Bun.spawn(['sh', '-c', hook.command], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Write payload to stdin
  proc.stdin.write(input);
  proc.stdin.end();

  // Set up timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Hook timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    let output = null;
    if (exitCode === 0 && stdout.trim()) {
      try {
        output = JSON.parse(stdout.trim());
      } catch {
        // stdout not valid JSON — treat as no output
      }
    }

    return { output, exitCode: exitCode as number, stderr };
  } catch (err) {
    // Timeout or other error
    return { output: null, exitCode: -1, stderr: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Public API — one function per hook event type
// ---------------------------------------------------------------------------

/**
 * Run pre_tool hooks. Returns allow/deny/modify decision.
 * Multiple hooks run sequentially; first deny or modify wins.
 */
export async function runPreToolHooks(
  toolName: string,
  toolInput: Record<string, any>,
  context: { channel_id: string; user_id: string },
): Promise<{ action: 'allow' | 'deny' | 'modify'; reason?: string; modified_input?: Record<string, any> }> {
  const hooks = getHooksForEvent('pre_tool').filter(h => matchesFilter(h, toolName));
  if (hooks.length === 0) return { action: 'allow' };

  const payload = { event: 'pre_tool', tool_name: toolName, tool_input: toolInput, ...context };

  for (const hook of hooks) {
    try {
      const { output, exitCode, stderr } = await executeHook(hook, payload);

      if (exitCode === 2) {
        return { action: 'deny', reason: stderr || 'Blocked by hook' };
      }

      if (exitCode === 0 && output) {
        if (output.action === 'deny') return { action: 'deny', reason: output.reason };
        if (output.action === 'modify' && output.modified_input) {
          return { action: 'modify', reason: output.reason, modified_input: output.modified_input };
        }
      }
      // Exit 0 with allow or no output, or any other exit → continue to next hook
    } catch (err) {
      // Hook execution failed — fail open, continue
      console.warn(`[hooks] pre_tool hook failed for "${toolName}":`, err);
    }
  }

  return { action: 'allow' };
}

/**
 * Run post_tool hooks. Returns optional extra context and suppress flag.
 * All matching hooks run; contexts are concatenated.
 */
export async function runPostToolHooks(
  toolName: string,
  toolInput: Record<string, any>,
  toolResult: any,
  context: { channel_id: string; user_id: string },
): Promise<{ context?: string; suppress_output?: boolean }> {
  const hooks = getHooksForEvent('post_tool').filter(h => matchesFilter(h, toolName));
  if (hooks.length === 0) return {};

  const payload = { event: 'post_tool', tool_name: toolName, tool_input: toolInput, tool_result: toolResult, ...context };

  const contexts: string[] = [];
  let suppress = false;

  for (const hook of hooks) {
    try {
      const { output, exitCode } = await executeHook(hook, payload);
      if (exitCode === 0 && output) {
        if (output.context) contexts.push(output.context);
        if (output.suppress_output) suppress = true;
      }
    } catch (err) {
      console.warn(`[hooks] post_tool hook failed for "${toolName}":`, err);
    }
  }

  return {
    context: contexts.length > 0 ? contexts.join('\n') : undefined,
    suppress_output: suppress || undefined,
  };
}

/**
 * Run on_message hooks. Returns allow/block decision.
 * First block wins; extra context is merged.
 */
export async function runMessageHook(
  message: string,
  context: { channel_id: string; user_id: string; display_name?: string },
): Promise<{ action: 'allow' | 'block'; reason?: string; context?: string }> {
  const hooks = getHooksForEvent('on_message');
  if (hooks.length === 0) return { action: 'allow' };

  const payload = { event: 'on_message', message, ...context };

  for (const hook of hooks) {
    try {
      const { output, exitCode, stderr } = await executeHook(hook, payload);
      if (exitCode === 2) return { action: 'block', reason: stderr || 'Blocked by hook' };
      if (exitCode === 0 && output?.action === 'block') return { action: 'block', reason: output.reason };
      if (exitCode === 0 && output?.context) {
        // Hook added context but allowed — return context with allow
        return { action: 'allow', context: output.context };
      }
    } catch (err) {
      console.warn('[hooks] on_message hook failed:', err);
    }
  }

  return { action: 'allow' };
}

/**
 * Run on_response hooks. Returns accept/continue decision.
 * First continue wins.
 */
export async function runResponseHook(
  response: string,
  toolCalls: number,
  context: { channel_id: string; user_id: string },
): Promise<{ action: 'accept' | 'continue'; reason?: string }> {
  const hooks = getHooksForEvent('on_response');
  if (hooks.length === 0) return { action: 'accept' };

  const payload = { event: 'on_response', response, tool_calls: toolCalls, ...context };

  for (const hook of hooks) {
    try {
      const { output, exitCode } = await executeHook(hook, payload);
      if (exitCode === 0 && output?.action === 'continue') {
        return { action: 'continue', reason: output.reason };
      }
    } catch (err) {
      console.warn('[hooks] on_response hook failed:', err);
    }
  }

  return { action: 'accept' };
}

/**
 * Run on_error hooks. Fire and forget — output is ignored.
 */
export async function runErrorHook(
  error: string,
  context: { channel_id: string; user_id: string },
): Promise<void> {
  const hooks = getHooksForEvent('on_error');
  if (hooks.length === 0) return;

  const payload = { event: 'on_error', error, ...context };

  // Fire and forget — run all hooks, don't wait for results
  for (const hook of hooks) {
    executeHook(hook, payload).catch(() => {});
  }
}
