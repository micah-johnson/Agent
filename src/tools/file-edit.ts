/**
 * File edit tool - make precise str_replace edits to existing files
 * Matches Claude Code's Edit tool pattern
 *
 * Two exports:
 *   fileEditTool          — static tool (used by sub-agents, no Slack access)
 *   createFileEditTool()  — factory that injects Slack client for threaded diff posts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { WebClient } from '@slack/web-api';
import type { Tool, ToolInput, ToolResult } from './types.js';
import { isCodeDiffsEnabled } from '../config/settings.js';

// ── Shared implementation ───────────────────────────────────────────────

const FILE_EDIT_SCHEMA = {
  type: 'object' as const,
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
      description:
        'If true, replace all occurrences. If false, only replace if unique. Default: false',
    },
  },
  required: ['file_path', 'old_string', 'new_string'] as string[],
};

interface SlackContext {
  client: WebClient;
  channel_id: string;
  getThreadTs?: () => string | null;
}

async function executeFileEdit(
  input: ToolInput,
  slack?: SlackContext,
): Promise<ToolResult> {
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
    const occurrences = (
      content.match(new RegExp(escapeRegex(oldString), 'g')) || []
    ).length;

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

    // Post text diff as threaded reply (fire-and-forget)
    if (slack && isCodeDiffsEnabled()) {
      postDiffThread(slack, oldString, newString, filePath).catch(() => {
        // silently ignore — diffs are best-effort
      });
    }

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
}

// ── Text diff ───────────────────────────────────────────────────────────

function buildDiffText(oldStr: string, newStr: string): string {
  const removed = oldStr.split('\n').map((l) => `- ${l}`);
  const added = newStr.split('\n').map((l) => `+ ${l}`);
  return [...removed, ...added].join('\n');
}

const MAX_DIFF_LENGTH = 2800; // stay under Slack's 3000-char code block limits

async function postDiffThread(
  slack: SlackContext,
  oldStr: string,
  newStr: string,
  filePath: string,
): Promise<void> {
  const threadTs = slack.getThreadTs?.();
  if (!threadTs) return; // no message to thread under

  let diff = buildDiffText(oldStr, newStr);
  if (diff.length > MAX_DIFF_LENGTH) {
    diff = diff.substring(0, MAX_DIFF_LENGTH) + '\n... (truncated)';
  }

  // Short filename for the header
  const shortPath = filePath.split('/').slice(-2).join('/');

  await slack.client.chat.postMessage({
    channel: slack.channel_id,
    thread_ts: threadTs,
    unfurl_links: false,
    text: `Diff: ${shortPath}`,
    blocks: [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `\`${shortPath}\`` }],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '```\n' + diff + '\n```',
        },
      },
    ],
  });
}

// ── Static tool (sub-agents — no Slack access) ─────────────────────────

export const fileEditTool: Tool = {
  name: 'file_edit',
  description:
    'Edit an existing file by replacing old_string with new_string. The old_string must match exactly (including whitespace). Use replace_all to replace all occurrences.',
  input_schema: FILE_EDIT_SCHEMA,

  async execute(input: ToolInput): Promise<ToolResult> {
    return executeFileEdit(input);
  },
};

// ── Factory (orchestrator — Slack-aware, posts threaded diffs) ──────────

export function createFileEditTool(
  client: WebClient,
  context: { channel_id: string; getThreadTs?: () => string | null },
): Tool {
  return {
    name: 'file_edit',
    description:
      'Edit an existing file by replacing old_string with new_string. The old_string must match exactly (including whitespace). Use replace_all to replace all occurrences.',
    input_schema: FILE_EDIT_SCHEMA,

    async execute(input: ToolInput): Promise<ToolResult> {
      return executeFileEdit(input, {
        client,
        channel_id: context.channel_id,
        getThreadTs: context.getThreadTs,
      });
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
