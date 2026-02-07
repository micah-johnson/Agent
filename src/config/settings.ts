/**
 * Centralized settings — loaded from data/settings.json, hot-reloaded on change.
 *
 * Start simple: permissions (who can talk to the agent).
 * Extend later: model prefs, tool toggles, rate limits, etc.
 */

import { readFileSync, watchFile, unwatchFile } from 'fs';
import { dataPath } from '../workspace/path.js';

const SETTINGS_PATH = dataPath('settings.json');

// ── Types ──────────────────────────────────────────────────────────────

export interface PermissionsSettings {
  /** "deny" = block everyone except allowedUsers. "allow" = allow everyone except deniedUsers. */
  defaultPolicy: 'allow' | 'deny';
  /** Slack user IDs that are explicitly allowed (used when defaultPolicy is "deny"). */
  allowedUsers: string[];
  /** Slack user IDs that are explicitly blocked (used when defaultPolicy is "allow"). */
  deniedUsers?: string[];
}

export interface ToolApprovalSettings {
  /** 'bypass' = no approval needed. 'approve' = each tool needs user approval. */
  defaultMode: 'bypass' | 'approve';
  /** Per-user overrides: userId → mode. */
  userOverrides?: Record<string, 'bypass' | 'approve'>;
  /** Tool names that never need approval regardless of mode. */
  alwaysAllow?: string[];
}

export interface Settings {
  permissions: PermissionsSettings;
  toolApproval?: ToolApprovalSettings;
  codeDiffs?: boolean;
  messageMode?: 'queue' | 'steer' | 'interrupt';
}

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  permissions: {
    defaultPolicy: 'deny',
    allowedUsers: [],
  },
};

// ── State ──────────────────────────────────────────────────────────────

let current: Settings = DEFAULT_SETTINGS;
let loaded = false;

// ── Load & Validate ────────────────────────────────────────────────────

function load(): Settings {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const settings: Settings = { ...DEFAULT_SETTINGS };

    if (raw.permissions && typeof raw.permissions === 'object') {
      const p = raw.permissions;
      settings.permissions = {
        defaultPolicy: p.defaultPolicy === 'allow' ? 'allow' : 'deny',
        allowedUsers: Array.isArray(p.allowedUsers)
          ? p.allowedUsers.filter((id: unknown) => typeof id === 'string')
          : [],
        deniedUsers: Array.isArray(p.deniedUsers)
          ? p.deniedUsers.filter((id: unknown) => typeof id === 'string')
          : undefined,
      };
    }

    if (typeof raw.codeDiffs === 'boolean') {
      settings.codeDiffs = raw.codeDiffs;
    }

    const validModes = ['queue', 'steer', 'interrupt'];
    if (typeof raw.messageMode === 'string' && validModes.includes(raw.messageMode)) {
      settings.messageMode = raw.messageMode as 'queue' | 'steer' | 'interrupt';
    }

    if (raw.toolApproval && typeof raw.toolApproval === 'object') {
      const t = raw.toolApproval;
      settings.toolApproval = {
        defaultMode: t.defaultMode === 'approve' ? 'approve' : 'bypass',
        userOverrides: t.userOverrides && typeof t.userOverrides === 'object'
          ? Object.fromEntries(
              Object.entries(t.userOverrides).filter(
                ([, v]) => v === 'bypass' || v === 'approve',
              ),
            ) as Record<string, 'bypass' | 'approve'>
          : undefined,
        alwaysAllow: Array.isArray(t.alwaysAllow)
          ? t.alwaysAllow.filter((n: unknown) => typeof n === 'string')
          : undefined,
      };
    }

    return settings;
  } catch (err: any) {
    console.error(`[settings] Failed to load ${SETTINGS_PATH}: ${err.message}`);
    return DEFAULT_SETTINGS;
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/** Get current settings (lazy-loads on first call). */
export function getSettings(): Settings {
  if (!loaded) {
    current = load();
    loaded = true;
  }
  return current;
}

/** Check if a Slack user ID is allowed to message the agent. */
export function isUserAllowed(userId: string): boolean {
  const { permissions } = getSettings();

  if (permissions.defaultPolicy === 'deny') {
    // Only explicitly listed users can talk
    return permissions.allowedUsers.includes(userId);
  } else {
    // Everyone allowed unless explicitly denied
    return !(permissions.deniedUsers ?? []).includes(userId);
  }
}

/** Get the tool approval mode for a given user. */
export function getToolApprovalMode(userId: string): 'bypass' | 'approve' {
  const { toolApproval } = getSettings();
  if (!toolApproval) return 'bypass';

  // Per-user override takes priority
  if (toolApproval.userOverrides?.[userId]) {
    return toolApproval.userOverrides[userId];
  }

  return toolApproval.defaultMode;
}

/** Check if a tool is in the settings-level always-allow list. */
export function isToolAlwaysAllowed(toolName: string): boolean {
  const { toolApproval } = getSettings();
  return toolApproval?.alwaysAllow?.includes(toolName) ?? false;
}

/** Check if code-diffs image generation is enabled. */
export function isCodeDiffsEnabled(): boolean {
  return getSettings().codeDiffs === true;
}

/** Get the current message mode (queue, steer, or interrupt). Defaults to steer. */
export function getMessageMode(): 'queue' | 'steer' | 'interrupt' {
  return getSettings().messageMode || 'steer';
}

/** Force reload settings from disk. */
export function reloadSettings(): Settings {
  current = load();
  loaded = true;
  console.log(
    `[settings] Reloaded — policy: ${current.permissions.defaultPolicy}, ` +
    `allowed: [${current.permissions.allowedUsers.join(', ')}]`
  );
  return current;
}

// ── File Watcher (hot reload) ──────────────────────────────────────────

let watching = false;

/** Start watching settings.json for changes. Call once at startup. */
export function watchSettings(): void {
  if (watching) return;
  watching = true;

  watchFile(SETTINGS_PATH, { interval: 2000 }, () => {
    console.log('[settings] Change detected, reloading...');
    reloadSettings();
  });

  console.log('✓ Settings watcher started');
}

/** Stop watching (for graceful shutdown). */
export function unwatchSettings(): void {
  if (!watching) return;
  unwatchFile(SETTINGS_PATH);
  watching = false;
}
