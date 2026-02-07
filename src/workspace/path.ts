/**
 * Workspace path resolver.
 *
 * The workspace is the instance-specific directory containing all config,
 * data, and secrets. It's separate from the agent code (this repo).
 *
 * Resolution order:
 *   1. AGENT_WORKSPACE env var
 *   2. ~/.agent/ (default)
 *
 * Structure:
 *   $WORKSPACE/
 *     .env            — tokens and secrets
 *     config/
 *       system-prompt.md
 *       projects.json
 *       mcp-servers.json
 *       cli-tools.json
 *     data/
 *       agent.sqlite
 *       knowledge.md
 *       settings.json
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';

let _workspacePath: string | null = null;

/** Get the workspace root path. */
export function getWorkspacePath(): string {
  if (_workspacePath) return _workspacePath;

  _workspacePath = process.env.AGENT_WORKSPACE || join(homedir(), '.agent');

  return _workspacePath;
}

/** Get path to a config file: $WORKSPACE/config/<name> */
export function configPath(name: string): string {
  return join(getWorkspacePath(), 'config', name);
}

/** Get path to a data file: $WORKSPACE/data/<name> */
export function dataPath(name: string): string {
  return join(getWorkspacePath(), 'data', name);
}

/** Get the workspace config directory. */
export function configDir(): string {
  return join(getWorkspacePath(), 'config');
}

/** Get the workspace data directory. */
export function dataDir(): string {
  return join(getWorkspacePath(), 'data');
}

/** Ensure the workspace directories exist. Called once at startup. */
export function ensureWorkspace(): void {
  const ws = getWorkspacePath();
  for (const dir of [ws, configDir(), dataDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  console.log(`✓ Workspace: ${ws}`);
}
