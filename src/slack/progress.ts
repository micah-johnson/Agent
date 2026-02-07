/**
 * Real-time progress updates for Slack messages.
 *
 * The progress context (colored circles, tool status) floats as a
 * context block appended to the latest bot message. When the model
 * posts rich content via post_rich_message, the progress indicator
 * moves to that message and the old progress-only message is deleted.
 *
 * Status circles:
 *   ⚫ thinking  🟠 running  🟢 success  🔴 error
 *
 * Throttled to max one Slack update per 1.5s.
 */

import type { WebClient } from '@slack/web-api';
import type { AgentLoopUsage, ProgressEvent, ToolProgressInfo } from '../agent/loop.js';

export type { ProgressEvent };

const MIN_INTERVAL_MS = 1500;
const MAX_CONTEXT_LENGTH = 2500;

interface CompletedTool {
  name: string;
  summary: string;
  success: boolean;
}

export class ProgressUpdater {
  private channelId: string;
  private client: WebClient;
  private messageTs: string | null = null;
  private baseBlocks: any[] = [];
  private richContentActive = false;
  private lastUpdateTime = 0;
  private pendingEvent: ProgressEvent | null = null;
  private lastEvent: ProgressEvent = { phase: 'thinking', iteration: 1 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private completed: CompletedTool[] = [];
  private currentTools: ToolProgressInfo[] | null = null;
  private startTime: number;

  constructor(channelId: string, client: WebClient) {
    this.channelId = channelId;
    this.client = client;
    this.startTime = Date.now();
  }

  async postInitial(): Promise<string> {
    const result = await this.client.chat.postMessage({
      channel: this.channelId,
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Thinking...' }] }],
      text: 'Thinking...',
    });
    this.messageTs = result.ts!;
    this.lastUpdateTime = Date.now();
    this.startHeartbeat();
    return this.messageTs;
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (this.messageTs) {
        this.lastUpdateTime = 0;
        this.pendingEvent = this.lastEvent;
        this.flush();
      }
    }, 5000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Called by post_rich_message when it posts a new message.
   * Moves progress tracking to the new message and deletes the old one.
   */
  adoptMessage(newTs: string, blocks: any[]): void {
    const oldTs = this.messageTs;
    const wasRichContent = this.richContentActive;

    this.messageTs = newTs;
    this.baseBlocks = blocks;
    this.richContentActive = true;

    // Delete old progress-only message (don't delete rich content)
    if (oldTs && !wasRichContent) {
      this.client.chat.delete({ channel: this.channelId, ts: oldTs }).catch(() => {});
    }
  }

  onProgress(event: ProgressEvent): void {
    if (event.phase === 'tools_start' && event.tools) {
      this.currentTools = event.tools;
    }

    if (event.phase === 'tools_done' && event.tools) {
      for (const tool of event.tools) {
        this.completed.push({
          name: tool.name,
          summary: summarizeArgs(tool.name, tool.args),
          success: tool.success ?? true,
        });
      }
      this.currentTools = null;
    }

    this.lastEvent = event;
    this.pendingEvent = event;
    this.scheduleUpdate();
  }

  async finalize(text: string, toolCalls: number, usage: AgentLoopUsage): Promise<void> {
    this.stopHeartbeat();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.messageTs) return;

    const durationMs = Date.now() - this.startTime;
    const footer = buildMetadataFooter(durationMs, toolCalls, usage);

    if (this.richContentActive) {
      // Rich content is already displayed — just add footer
      await this.client.chat.update({
        channel: this.channelId,
        ts: this.messageTs,
        blocks: [...this.baseBlocks, footer],
        text,
      });
    } else {
      // Replace progress message with text response + footer
      await this.client.chat.update({
        channel: this.channelId,
        ts: this.messageTs,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text } },
          footer,
        ],
        text,
      });
    }
  }

  async abort(errorText: string): Promise<void> {
    this.stopHeartbeat();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.messageTs) return;

    await this.client.chat
      .update({
        channel: this.channelId,
        ts: this.messageTs,
        blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: errorText }] }],
        text: errorText,
      })
      .catch(() => {});
  }

  getMessageTs(): string | null {
    return this.messageTs;
  }

  // --- private ---

  private scheduleUpdate(): void {
    const elapsed = Date.now() - this.lastUpdateTime;
    if (elapsed >= MIN_INTERVAL_MS) {
      this.flush();
    } else if (!this.timer) {
      const delay = MIN_INTERVAL_MS - elapsed;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, delay);
    }
  }

  private flush(): void {
    if (!this.pendingEvent || !this.messageTs) return;

    const event = this.pendingEvent;
    this.pendingEvent = null;
    this.lastUpdateTime = Date.now();

    const progressBlock = this.buildProgressContext(event);

    // Append progress context to base blocks (rich content) or show standalone
    const blocks = this.richContentActive
      ? [...this.baseBlocks, progressBlock]
      : [progressBlock];

    this.client.chat
      .update({
        channel: this.channelId,
        ts: this.messageTs,
        blocks,
        text: 'Working...',
      })
      .catch(() => {});
  }

  private buildProgressContext(event: ProgressEvent): any {
    const lines: string[] = [];

    // Completed tools
    for (const tool of this.completed) {
      const circle = tool.success ? '\ud83d\udfe2' : '\ud83d\udd34';
      lines.push(`${circle} ${tool.name}(${tool.summary})`);
    }

    // Currently running tools
    if (event.phase === 'tools_start' && this.currentTools) {
      for (const tool of this.currentTools) {
        lines.push(`\ud83d\udfe0 ${tool.name}(${summarizeArgs(tool.name, tool.args)})`);
      }
    } else {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
      lines.push(`Thinking... (${elapsed}s)`);
    }

    let text = lines.join('\n');

    // Overflow protection
    while (text.length > MAX_CONTEXT_LENGTH && lines.length > 2) {
      lines.shift();
      text = ['...', ...lines].join('\n');
    }

    return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
  }
}

/**
 * Extract the most descriptive argument for a tool call.
 */
function summarizeArgs(toolName: string, args: Record<string, any>): string {
  let summary = '';

  switch (toolName) {
    case 'bash':
      summary = args.command || '';
      break;
    case 'file_read':
      summary = args.path || args.file_path || '';
      break;
    case 'file_write':
      summary = args.path || args.file_path || '';
      break;
    case 'file_edit':
      summary = args.path || args.file_path || '';
      break;
    case 'grep':
      summary = args.pattern ? `"${args.pattern}"` : '';
      if (args.path) summary += ` in ${args.path}`;
      break;
    case 'spawn_subagent':
      summary = args.task || args.description || '';
      break;
    case 'search_memory':
      summary = args.query ? `"${args.query}"` : '';
      break;
    case 'update_knowledge':
      summary = args.action || '';
      break;
    case 'get_project_context':
      summary = args.project || '';
      break;
    case 'post_rich_message':
      summary = args.text || 'blocks';
      break;
    case 'check_tasks':
      summary = args.status || 'all';
      break;
    default: {
      const firstVal = Object.values(args).find((v) => typeof v === 'string');
      summary = typeof firstVal === 'string' ? firstVal : '';
    }
  }

  if (summary.length > 80) {
    summary = summary.substring(0, 77) + '...';
  }

  return summary;
}

export function buildMetadataFooter(
  durationMs: number,
  toolCalls: number,
  usage: AgentLoopUsage,
): any {
  const parts: string[] = [];

  parts.push(`${(durationMs / 1000).toFixed(1)}s`);

  if (toolCalls > 0) {
    parts.push(`${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}`);
  }

  parts.push(`${usage.totalTokens.toLocaleString('en-US')} tokens`);

  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: parts.join('  \u00b7  ') }],
  };
}
