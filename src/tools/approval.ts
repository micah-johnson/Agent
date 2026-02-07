/**
 * Tool approval gate — pauses agent loop execution and waits for
 * user approval via Slack buttons before running tools.
 *
 * Three decisions:
 *   ✓  Accept  — run this tool call once
 *   ✓✓ Always  — auto-approve this tool name for the rest of the session
 *   ✗  Deny    — skip this tool call, return error to Claude
 *
 * Session whitelist resets on restart. Settings-level alwaysAllow persists.
 */

import type { WebClient } from '@slack/web-api';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export type ApprovalDecision = 'accept' | 'always' | 'deny';

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Pending approvals keyed by unique approval ID
const pendingApprovals = new Map<string, PendingApproval>();

// Session whitelist: channelId → Set of tool names auto-approved for this session
const sessionWhitelist = new Map<string, Set<string>>();

let approvalCounter = 0;

// ── Session Whitelist ──────────────────────────────────────────────────

export function isSessionWhitelisted(channelId: string, toolName: string): boolean {
  return sessionWhitelist.get(channelId)?.has(toolName) ?? false;
}

export function addToSessionWhitelist(channelId: string, toolName: string): void {
  if (!sessionWhitelist.has(channelId)) {
    sessionWhitelist.set(channelId, new Set());
  }
  sessionWhitelist.get(channelId)!.add(toolName);
}

// ── Approval Flow ──────────────────────────────────────────────────────

/**
 * Post an approval prompt to Slack and wait for the user's decision.
 * Returns 'deny' on timeout (5 min) or abort signal.
 */
export async function requestToolApproval(
  toolName: string,
  toolArgs: Record<string, any>,
  channelId: string,
  client: WebClient,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  const approvalId = `approval_${++approvalCounter}_${Date.now()}`;

  const argDisplay = formatToolArgs(toolName, toolArgs);

  await client.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔧 *${toolName}*\n${argDisplay}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✓' },
            value: approvalId,
            action_id: `tool_approve:${approvalId}`,
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✓✓' },
            value: approvalId,
            action_id: `tool_always:${approvalId}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✗' },
            value: approvalId,
            action_id: `tool_deny:${approvalId}`,
            style: 'danger',
          },
        ],
      },
    ],
    text: `Approve tool: ${toolName}?`,
  });

  return new Promise<ApprovalDecision>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      pendingApprovals.delete(approvalId);
      signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve('deny');
    }, APPROVAL_TIMEOUT_MS);

    const onAbort = () => {
      cleanup();
      resolve('deny');
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    pendingApprovals.set(approvalId, {
      resolve: (decision) => {
        cleanup();
        resolve(decision);
      },
      timer,
    });
  });
}

/**
 * Called by the Slack action handler when the user clicks an approval button.
 * Returns true if a pending approval was found and resolved.
 */
export function resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return false;

  pending.resolve(decision);
  return true;
}

/**
 * Check if an action_id is a tool approval action.
 * Returns the approval ID and decision, or null if not an approval action.
 */
export function parseApprovalAction(actionId: string): { approvalId: string; decision: ApprovalDecision } | null {
  if (actionId.startsWith('tool_approve:')) {
    return { approvalId: actionId.slice('tool_approve:'.length), decision: 'accept' };
  }
  if (actionId.startsWith('tool_always:')) {
    return { approvalId: actionId.slice('tool_always:'.length), decision: 'always' };
  }
  if (actionId.startsWith('tool_deny:')) {
    return { approvalId: actionId.slice('tool_deny:'.length), decision: 'deny' };
  }
  return null;
}

// ── Display Formatting ─────────────────────────────────────────────────

function formatToolArgs(toolName: string, args: Record<string, any>): string {
  switch (toolName) {
    case 'Bash':
    case 'bash':
      return '```\n' + (args.command || '') + '\n```';

    case 'file_write': {
      const content = args.content || '';
      const preview = content.length > 300 ? content.substring(0, 300) + '...' : content;
      return `\`${args.file_path || ''}\`\n\`\`\`\n${preview}\n\`\`\``;
    }

    case 'file_edit':
      return (
        `\`${args.file_path || ''}\`\n` +
        `*old:*\n\`\`\`\n${(args.old_string || '').substring(0, 200)}\n\`\`\`\n` +
        `*new:*\n\`\`\`\n${(args.new_string || '').substring(0, 200)}\n\`\`\``
      );

    case 'file_read':
      return `\`${args.file_path || ''}\``;

    case 'Grep':
    case 'grep':
      return `\`${args.pattern || ''}\`${args.path ? ` in \`${args.path}\`` : ''}`;

    case 'spawn_subagent': {
      const prompt = args.prompt || '';
      return (
        `*${args.title || ''}*\n` +
        (prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt)
      );
    }

    default: {
      const json = JSON.stringify(args, null, 2);
      return '```\n' + (json.length > 300 ? json.substring(0, 300) + '...' : json) + '\n```';
    }
  }
}
