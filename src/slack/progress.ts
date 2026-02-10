/**
 * Real-time progress updates for Slack messages.
 *
 * The progress context (colored circles, tool status) floats as a
 * context block appended to the latest bot message. When the model
 * posts rich content via post_rich_message, the progress indicator
 * moves to that message and the old progress-only message is deleted.
 *
 * Status circles:
 *   🟠 running  🟢 success  🔴 error
 *
 * Throttled to max one Slack update per 1.5s.
 *
 * postInitial() is non-blocking — the Slack API call fires in the
 * background so the Claude API call can start immediately. finalize()
 * awaits the initial message to complete, then uses the fast chat.update
 * path. A `disposed` flag prevents zombie heartbeats from late-resolving
 * postInitial.
 */

import type { WebClient } from '@slack/web-api';
import type { AgentLoopUsage, ProgressEvent, ToolProgressInfo } from '../agent/loop.js';
import { getDisplaySettings } from '../config/settings.js';
import { getProcessManager } from '../processes/manager.js';

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
  private messageReady: Promise<void> | null = null;
  private baseBlocks: any[] = [];
  private richContentActive = false;
  private disposed = false;
  private lastUpdateTime = 0;
  private pendingEvent: ProgressEvent | null = null;
  private lastEvent: ProgressEvent = { phase: 'thinking', iteration: 1 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private completed: CompletedTool[] = [];
  private currentTools: ToolProgressInfo[] | null = null;
  private startTime: number;
  /** Tracks intermediate text on the current message so finalize knows to start a new message. */
  private intermediateText: string | null = null;

  constructor(channelId: string, client: WebClient) {
    this.channelId = channelId;
    this.client = client;
    this.startTime = Date.now();
  }

  /**
   * Fire the initial "Thinking..." message to Slack.
   * Non-blocking — returns immediately while the API call runs in the background.
   * When showProgress is false, skips the initial message — finalize() will post directly.
   */
  postInitial(): void {
    const { showProgress } = getDisplaySettings();
    if (!showProgress) return;

    const initialBlocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Thinking...' }] }];
    const initialText = 'Thinking...';

    this.messageReady = this.client.chat
      .postMessage({
        channel: this.channelId,
        blocks: initialBlocks,
        text: initialText,
      })
      .then((result) => {
        this.messageTs = result.ts!;
        this.lastUpdateTime = Date.now();
        // Only start heartbeat if we haven't been disposed
        if (!this.disposed) {
          this.startHeartbeat();
          if (this.pendingEvent) {
            this.flush();
          }
        }
      })
      .catch(() => {
        // If initial post fails, subsequent updates will no-op
      });
  }

  private startHeartbeat(): void {
    const { showProgress } = getDisplaySettings();
    if (!showProgress) return;

    this.heartbeat = setInterval(() => {
      if (this.messageTs && !this.disposed) {
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

  private dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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
    this.intermediateText = null; // Rich message takes over

    if (oldTs && !wasRichContent) {
      this.client.chat.delete({ channel: this.channelId, ts: oldTs }).catch(() => {});
    }
  }

  onProgress(event: ProgressEvent): void {
    if (this.disposed) return;

    const { showProgress } = getDisplaySettings();
    if (!showProgress) return;

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
    this.dispose();

    const { showMetadata } = getDisplaySettings();

    const durationMs = Date.now() - this.startTime;
    const footer = buildMetadataFooter(durationMs, toolCalls, usage);

    // Wait for the initial message to be posted (reuses the HTTPS connection)
    if (this.messageReady) await this.messageReady;

    if (this.intermediateText) {
      // There's intermediate text on the current message — finalize it (text only, permanent)
      if (this.messageTs) {
        try {
          await this.client.chat.update({
            channel: this.channelId,
            ts: this.messageTs,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: this.intermediateText } }],
            text: this.intermediateText,
          });
        } catch { /* non-fatal */ }
      }

      // Post the final response as a new message
      const blocks = showMetadata
        ? [{ type: 'section', text: { type: 'mrkdwn', text } }, footer]
        : [{ type: 'section', text: { type: 'mrkdwn', text } }];

      await this.client.chat.postMessage({
        channel: this.channelId,
        blocks,
        text,
      });
    } else {
      // No intermediate text — normal finalize on the existing message
      const blocks = this.richContentActive
        ? showMetadata ? [...this.baseBlocks, footer] : [...this.baseBlocks]
        : showMetadata ? [{ type: 'section', text: { type: 'mrkdwn', text } }, footer] : [{ type: 'section', text: { type: 'mrkdwn', text } }];

      if (this.messageTs) {
        await this.client.chat.update({
          channel: this.channelId,
          ts: this.messageTs,
          blocks,
          text,
        });
      } else {
        await this.client.chat.postMessage({
          channel: this.channelId,
          blocks,
          text,
        });
      }
    }
  }

  /**
   * Surface intermediate text on the current message with progress appended below.
   * On the FIRST call, the current "Thinking..." message becomes the intermediate text.
   * On subsequent calls, the current message is finalized (text only) and a new message starts.
   */
  async showIntermediateText(text: string): Promise<void> {
    if (this.disposed) return;
    if (this.messageReady) await this.messageReady;

    // No initial message (progress disabled) — post a fresh message for the intermediate text
    if (!this.messageTs) {
      try {
        const result = await this.client.chat.postMessage({
          channel: this.channelId,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
          text,
        });
        this.messageTs = result.ts!;
      } catch { return; }
      this.intermediateText = text;
      this.baseBlocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
      this.richContentActive = true;
      return;
    }

    // If there's already intermediate text on this message, finalize it and start a new message
    if (this.intermediateText) {
      // Kill heartbeat/timers so they don't re-append progress after our clean update
      this.stopHeartbeat();
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.pendingEvent = null;

      // Strip progress from old message — just the text, permanent
      try {
        await this.client.chat.update({
          channel: this.channelId,
          ts: this.messageTs,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: this.intermediateText } }],
          text: this.intermediateText,
        });
      } catch { /* non-fatal */ }

      // Post a fresh message for the new intermediate text
      try {
        const result = await this.client.chat.postMessage({
          channel: this.channelId,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
          text,
        });
        this.messageTs = result.ts!;
      } catch { /* non-fatal */ }

      // Restart heartbeat for the new message
      this.startHeartbeat();
    }

    // Set intermediate text as the base content — progress will append below
    this.intermediateText = text;
    this.baseBlocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
    this.richContentActive = true;
    this.completed = [];
    this.currentTools = null;
    this.lastUpdateTime = 0; // Ensure first progress event on new message flushes immediately

    // Update current message to show the text immediately
    try {
      await this.client.chat.update({
        channel: this.channelId,
        ts: this.messageTs,
        blocks: this.baseBlocks,
        text,
      });
    } catch { /* non-fatal */ }
  }

  async abort(errorText: string): Promise<void> {
    this.dispose();

    if (this.messageReady) await this.messageReady;

    const blocks = [{ type: 'context', elements: [{ type: 'mrkdwn', text: errorText }] }];

    if (this.messageTs) {
      await this.client.chat
        .update({ channel: this.channelId, ts: this.messageTs, blocks, text: errorText })
        .catch(() => {});
    } else {
      await this.client.chat
        .postMessage({ channel: this.channelId, blocks, text: errorText })
        .catch(() => {});
    }
  }

  /**
   * Cleanly dismiss the progress message on steer.
   * - If there's intermediate text, keep it but strip progress context.
   * - If it's just a status message, delete it entirely.
   */
  async dismiss(): Promise<void> {
    this.dispose();

    if (this.messageReady) await this.messageReady;
    if (!this.messageTs) return;

    if (this.intermediateText) {
      // Keep the intermediate text, strip progress
      await this.client.chat
        .update({
          channel: this.channelId,
          ts: this.messageTs,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: this.intermediateText } }],
          text: this.intermediateText,
        })
        .catch(() => {});
    } else {
      // Just a status message — delete it
      await this.client.chat
        .delete({ channel: this.channelId, ts: this.messageTs })
        .catch(() => {});
    }
  }

  getMessageTs(): string | null {
    return this.messageTs;
  }

  // --- private ---

  private scheduleUpdate(): void {
    if (this.disposed) return;
    const elapsed = Date.now() - this.lastUpdateTime;
    if (elapsed >= MIN_INTERVAL_MS) {
      this.flush();
    } else if (!this.timer) {
      const delay = MIN_INTERVAL_MS - elapsed;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.disposed) this.flush();
      }, delay);
    }
  }

  private flush(): void {
    if (!this.pendingEvent || !this.messageTs || this.disposed) return;

    const event = this.pendingEvent;
    this.pendingEvent = null;
    this.lastUpdateTime = Date.now();

    const progressBlock = this.buildProgressContext(event);

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

    // Collapsed summary of completed tools
    if (this.completed.length > 0) {
      const succeeded = this.completed.filter(t => t.success).length;
      const failed = this.completed.length - succeeded;
      let summary = `✓ ${succeeded} tool${succeeded !== 1 ? 's' : ''} completed`;
      if (failed > 0) summary += ` · ${failed} failed`;
      lines.push(summary);
    }

    // Expanded currently running tools
    if (event.phase === 'tools_start' && this.currentTools) {
      for (const tool of this.currentTools) {
        lines.push(`🟠 ${tool.name}(${summarizeArgs(tool.name, tool.args)})`);
      }
    } else {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);
      lines.push(`Thinking... (${elapsed}s)`);
    }

    let text = lines.join('\n');

    if (text.length > MAX_CONTEXT_LENGTH) {
      text = text.substring(0, MAX_CONTEXT_LENGTH - 3) + '...';
    }

    return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
  }
}

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

  summary = summary.replace(/\n/g, '\\n');

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

  // Show running background process count if any
  const runningProcesses = getProcessManager().list().filter((p) => p.status === 'running').length;
  if (runningProcesses > 0) {
    parts.push(`${runningProcesses} background ${runningProcesses === 1 ? 'process' : 'processes'}`);
  }

  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: parts.join('  \u00b7  ') }],
  };
}
