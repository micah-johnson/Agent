/**
 * Orchestrator — glue layer connecting TaskStore, WorkerPool, and Slack
 *
 * When sub-agents complete, results are buffered and debounced (3s),
 * then fed back through the orchestrator model via processMessage()
 * so the model can synthesize and format results naturally.
 *
 * Channel concurrency locks prevent user messages and sub-agent results
 * from interleaving on the same channel.
 */

import type { WebClient } from '@slack/web-api';
import { TaskStore } from '../tasks/store.js';
import { WorkerPool } from '../subagent/pool.js';
import { indexMessages } from '../memory/indexer.js';
import type { ClaudeClient } from '../llm/client.js';
import type { ProgressUpdater } from '../slack/progress.js';

const DEBOUNCE_MS = 3000;
const MAX_RESULT_LENGTH = 3000;
const MAX_RESULT_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

interface PendingResult {
  taskId: string;
  title: string;
  channelId: string;
  userId: string;
  status: 'completed' | 'failed';
  result: string | null;
  error: string | null;
  retryCount?: number;
}

export class Orchestrator {
  readonly store: TaskStore;
  readonly pool: WorkerPool;
  private slackClient: WebClient | null = null;
  private claudeClient: ClaudeClient | null = null;
  private pendingResults = new Map<string, PendingResult[]>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private channelLocks = new Map<string, Promise<void>>();
  private activeAbort = new Map<string, AbortController>();
  private activeProgress = new Map<string, ProgressUpdater>();
  private steerQueues = new Map<string, { message: string; attachments?: any[] }[]>();
  private callAborts = new Map<string, AbortController>();

  constructor(apiKey: string) {
    this.store = new TaskStore();
    this.pool = new WorkerPool(this.store, apiKey);

    this.pool.on('task:complete', (taskId: string) => {
      this.onTaskComplete(taskId);
    });
  }

  setSlackClient(client: WebClient): void {
    this.slackClient = client;
  }

  setClaudeClient(claude: ClaudeClient): void {
    this.claudeClient = claude;
  }

  /**
   * Create an AbortController for a channel's active work.
   * Returns the signal to pass through the processing pipeline.
   */
  createAbortSignal(channelId: string): AbortSignal {
    const controller = new AbortController();
    this.activeAbort.set(channelId, controller);
    return controller.signal;
  }

  /**
   * Track the active ProgressUpdater for a channel so stop can update it.
   */
  setActiveProgress(channelId: string, progress: ProgressUpdater): void {
    this.activeProgress.set(channelId, progress);
  }

  /**
   * Clear the abort controller and progress tracker for a channel.
   */
  clearAbortSignal(channelId: string): void {
    this.activeAbort.delete(channelId);
    this.activeProgress.delete(channelId);
    this.steerQueues.delete(channelId);
    this.callAborts.delete(channelId);
  }

  /**
   * Check if a channel has active work (an abort controller registered).
   */
  isChannelActive(channelId: string): boolean {
    return this.activeAbort.has(channelId);
  }

  /**
   * Push a steer message and abort the current API call (if in thinking phase).
   */
  steerChannel(channelId: string, message: string, attachments?: any[]): void {
    if (!this.steerQueues.has(channelId)) {
      this.steerQueues.set(channelId, []);
    }
    this.steerQueues.get(channelId)!.push({ message, attachments });

    // Abort current API call to interrupt thinking
    const callAbort = this.callAborts.get(channelId);
    if (callAbort) {
      callAbort.abort();
    }
  }

  /**
   * Consume the next steer message (called by the loop).
   */
  consumeSteer(channelId: string): { message: string; attachments?: any[] } | null {
    const queue = this.steerQueues.get(channelId);
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }

  /**
   * Register the current API call's AbortController for steer interruption.
   */
  registerCallAbort(channelId: string, controller: AbortController): void {
    this.callAborts.set(channelId, controller);
  }

  /**
   * Clear the current API call's AbortController.
   */
  clearCallAbort(channelId: string): void {
    this.callAborts.delete(channelId);
  }

  /**
   * Abort the currently active work on a channel.
   * Immediately updates the progress message to show "Aborted".
   * Returns true if there was something to abort.
   */
  async abortChannel(channelId: string): Promise<boolean> {
    let aborted = false;

    // Abort the orchestrator's active work
    const controller = this.activeAbort.get(channelId);
    if (controller) {
      controller.abort();
      this.activeAbort.delete(channelId);

      const progress = this.activeProgress.get(channelId);
      if (progress) {
        await progress.abort('Aborted');
        this.activeProgress.delete(channelId);
      }

      aborted = true;
    }

    // Cancel any running or queued sub-agents for this channel
    const cancelledSubAgents = this.pool.cancelByChannel(channelId);
    if (cancelledSubAgents > 0) aborted = true;

    // Clear any pending debounced results for this channel
    const timer = this.debounceTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(channelId);
    }
    this.pendingResults.delete(channelId);

    return aborted;
  }

  /**
   * Serialize async work per channel. Both user-initiated messages
   * and sub-agent result processing acquire this lock.
   */
  async withChannelLock(channelId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.channelLocks.get(channelId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.channelLocks.set(channelId, next.catch(() => {}));
    await next;
  }

  private async onTaskComplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;

    // Index task content for memory search (async, don't block)
    indexMessages('task', taskId, [
      { role: 'task_prompt', content: `${task.title}: ${task.prompt}` },
      ...(task.result ? [{ role: 'task_result', content: task.result }] : []),
      ...(task.error ? [{ role: 'task_result', content: `Error: ${task.error}` }] : []),
    ]).catch((err) => {
      console.error(`[orchestrator] Failed to index task ${taskId}: ${err?.message || err}`);
    });

    // Buffer the result
    const pending: PendingResult = {
      taskId: task.id,
      title: task.title,
      channelId: task.channel_id,
      userId: task.user_id,
      status: task.status as 'completed' | 'failed',
      result: task.result,
      error: task.error,
    };

    const channelId = task.channel_id;
    if (!this.pendingResults.has(channelId)) {
      this.pendingResults.set(channelId, []);
    }
    this.pendingResults.get(channelId)!.push(pending);

    // Reset debounce timer for this channel
    const existingTimer = this.debounceTimers.get(channelId);
    if (existingTimer) clearTimeout(existingTimer);

    this.debounceTimers.set(
      channelId,
      setTimeout(() => {
        this.debounceTimers.delete(channelId);
        this.processPendingResults(channelId);
      }, DEBOUNCE_MS),
    );
  }

  private async processPendingResults(channelId: string): Promise<void> {
    const results = this.pendingResults.get(channelId);
    this.pendingResults.delete(channelId);
    if (!results || results.length === 0) return;

    if (!this.slackClient || !this.claudeClient) {
      console.error('[orchestrator] Cannot process results: missing Slack or Claude client');
      return;
    }

    const syntheticMessage = this.buildResultMessage(results);
    const userId = results[0].userId;
    const client = this.slackClient;
    const claude = this.claudeClient;

    // Lazy import to avoid circular dependency at module load time
    const { processMessage, log } = await import('../slack/process-message.js');
    const { ProgressUpdater } = await import('../slack/progress.js');

    await this.withChannelLock(channelId, async () => {
      const signal = this.createAbortSignal(channelId);
      const progressRef = { current: new ProgressUpdater(channelId, client) };
      this.setActiveProgress(channelId, progressRef.current);
      try {
        progressRef.current.postInitial(); // Non-blocking

        // Build steer callbacks for sub-agent result processing
        const steer = {
          consume: () => this.consumeSteer(channelId),
          registerCallAbort: (controller: AbortController) => this.registerCallAbort(channelId, controller),
          clearCallAbort: () => this.clearCallAbort(channelId),
          onSteer: (message: string) => {
            log(`[orchestrator] Steer injected during sub-agent processing: "${message.substring(0, 80)}"`);
            const oldProgress = progressRef.current;
            oldProgress.dismiss().catch(() => {});
            const newProgress = new ProgressUpdater(channelId, client);
            newProgress.postInitial();
            progressRef.current = newProgress;
            this.setActiveProgress(channelId, newProgress);
          },
        };

        const result = await processMessage(
          channelId,
          userId,
          syntheticMessage,
          client,
          claude,
          this,
          (event) => progressRef.current.onProgress(event),
          (ts, blocks) => progressRef.current.adoptMessage(ts, blocks),
          signal,
          undefined,
          () => progressRef.current.getMessageTs(),
          steer,
        );

        if (!signal.aborted) {
          await progressRef.current.finalize(result.text, result.toolCalls, result.usage);
        }
      } catch (err: any) {
        if (!signal.aborted) {
          log(`[orchestrator] Failed to process sub-agent results: ${err?.message || err}`);
          await progressRef.current.abort('Sorry, something went wrong processing sub-agent results.');

          // Re-queue results for retry if under MAX_RESULT_RETRIES
          const maxRetry = Math.max(...results.map((r) => r.retryCount ?? 0));
          if (maxRetry < MAX_RESULT_RETRIES) {
            const retried = results.map((r) => ({
              ...r,
              retryCount: (r.retryCount ?? 0) + 1,
            }));
            log(`[orchestrator] Re-queuing ${retried.length} results for retry (attempt ${retried[0].retryCount}/${MAX_RESULT_RETRIES})`);
            setTimeout(() => {
              if (!this.pendingResults.has(channelId)) {
                this.pendingResults.set(channelId, []);
              }
              this.pendingResults.get(channelId)!.push(...retried);
              this.processPendingResults(channelId);
            }, RETRY_DELAY_MS);
          } else {
            log(`[orchestrator] Max retries (${MAX_RESULT_RETRIES}) reached for channel ${channelId}, dropping results`);
          }
        }
      } finally {
        this.clearAbortSignal(channelId);
      }
    });
  }

  private buildResultMessage(results: PendingResult[]): string {
    if (results.length === 1) {
      const r = results[0];
      const status = r.status === 'completed' ? 'completed' : 'failed';
      let body: string;
      if (r.status === 'completed') {
        body = truncate(r.result || 'Task completed with no output.', MAX_RESULT_LENGTH);
      } else {
        body = `Error: ${r.error || 'Unknown error'}`;
      }
      return `[Sub-agent result] Task: "${r.title}"\nStatus: ${status}\n\n${body}`;
    }

    const completedCount = results.filter((r) => r.status === 'completed').length;
    const failedCount = results.filter((r) => r.status === 'failed').length;
    const parts: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const status = r.status === 'completed' ? 'completed' : 'failed';
      let body: string;
      if (r.status === 'completed') {
        body = truncate(r.result || 'Task completed with no output.', MAX_RESULT_LENGTH);
      } else {
        body = `Error: ${r.error || 'Unknown error'}`;
      }
      parts.push(`${i + 1}. "${r.title}" — ${status}\n${body}`);
    }

    const summary = [
      completedCount > 0 ? `${completedCount} completed` : null,
      failedCount > 0 ? `${failedCount} failed` : null,
    ]
      .filter(Boolean)
      .join(', ');

    return `[Sub-agent results] ${results.length} tasks (${summary}):\n\n${parts.join('\n\n')}`;
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 20) + '\n... (truncated)';
}
