/**
 * Worker pool — concurrency-limited execution of sub-agent tasks
 *
 * submit() is fire-and-forget. Tasks run immediately if under the
 * concurrency limit, otherwise they queue. On completion, the next
 * queued task is drained automatically.
 *
 * cancelByChannel() aborts all running tasks and removes queued tasks
 * for a given channel, enabling the stop command to kill sub-agents.
 */

import { EventEmitter } from 'events';
import { runSubAgent } from './worker.js';
import type { Task, TaskStore } from '../tasks/store.js';
import { getAgentSettings } from '../config/settings.js';
import { ABORTED_SENTINEL } from '../agent/loop.js';

/** Maximum time a sub-agent can run before being killed (10 minutes). */
const SUB_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

export class WorkerPool extends EventEmitter {
  private running: Map<string, Promise<void>> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private queue: Task[] = [];
  private store: TaskStore;
  private apiKey: string;

  constructor(store: TaskStore, apiKey: string) {
    super();
    this.store = store;
    this.apiKey = apiKey;
  }

  submit(task: Task): { queued: boolean; position?: number } {
    if (this.running.size < getAgentSettings().maxConcurrentSubagents) {
      this.run(task);
      return { queued: false };
    } else {
      this.queue.push(task);
      return { queued: true, position: this.queue.length };
    }
  }

  /**
   * Cancel a specific task by ID. Returns true if found and cancelled.
   */
  cancelTask(taskId: string): boolean {
    // Check running tasks
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.store.markFailed(taskId, 'Cancelled');
      return true;
    }

    // Check queued tasks
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      this.store.markFailed(taskId, 'Cancelled');
      return true;
    }

    return false;
  }

  /**
   * Cancel all running and queued tasks for a channel.
   * Returns the number of tasks cancelled.
   */
  cancelByChannel(channelId: string): number {
    let cancelled = 0;

    // Abort running tasks for this channel
    for (const [taskId, controller] of this.abortControllers) {
      const task = this.store.get(taskId);
      if (task && task.channel_id === channelId) {
        controller.abort();
        this.store.markFailed(taskId, 'Cancelled by user');
        cancelled++;
      }
    }

    // Remove queued tasks for this channel
    const before = this.queue.length;
    this.queue = this.queue.filter((task) => {
      if (task.channel_id === channelId) {
        this.store.markFailed(task.id, 'Cancelled by user');
        cancelled++;
        return false;
      }
      return true;
    });

    return cancelled;
  }

  getStatus(): { active: number; queued: number; tasks: { id: string; title: string; status: string }[] } {
    const tasks: { id: string; title: string; status: string }[] = [];

    for (const taskId of this.running.keys()) {
      const task = this.store.get(taskId);
      if (task) {
        tasks.push({ id: task.id, title: task.title, status: 'running' });
      }
    }

    for (const task of this.queue) {
      tasks.push({ id: task.id, title: task.title, status: 'queued' });
    }

    return {
      active: this.running.size,
      queued: this.queue.length,
      tasks,
    };
  }

  private run(task: Task): void {
    this.store.markRunning(task.id);

    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);

    // Hard timeout — kill sub-agent if it runs too long
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        console.log(`[pool] Sub-agent "${task.title}" timed out after ${SUB_AGENT_TIMEOUT_MS / 1000}s — aborting`);
        controller.abort();
        this.store.markFailed(task.id, `Timed out after ${SUB_AGENT_TIMEOUT_MS / 60000} minutes`);
        this.emit('task:complete', task.id);
      }
    }, SUB_AGENT_TIMEOUT_MS);

    const promise = this.execute(task, controller.signal).finally(() => {
      clearTimeout(timeout);
      this.running.delete(task.id);
      this.abortControllers.delete(task.id);
      this.drain();
    });

    this.running.set(task.id, promise);
  }

  private async execute(task: Task, signal: AbortSignal): Promise<void> {
    try {
      const result = await runSubAgent(task, this.apiKey, signal);

      // Don't mark completed if aborted — cancelByChannel already marked it failed
      if (signal.aborted) return;


      // If the loop returned the abort sentinel, the model stopped unexpectedly
      // (e.g. API returned 'aborted' stopReason due to context overflow).
      // Treat as a failure so it doesn't surface as a real result.
      if (result.text === ABORTED_SENTINEL) {
        this.store.markFailed(task.id, 'Sub-agent stopped unexpectedly (model returned aborted)');
        this.emit('task:complete', task.id);
        return;
      }
      this.store.markCompleted(task.id, result.text, {
        iterations: result.iterations,
        toolCalls: result.toolCalls,
      });

      this.emit('task:complete', task.id);
    } catch (error: unknown) {
      if (signal.aborted) return;

      const msg = error instanceof Error ? error.message : String(error);
      this.store.markFailed(task.id, msg);
      this.emit('task:complete', task.id);
    }
  }

  private drain(): void {
    while (this.running.size < getAgentSettings().maxConcurrentSubagents && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.run(next);
    }
  }

  get activeCount(): number {
    return this.running.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Clean up orphaned tasks — tasks stuck in 'running' or 'pending' status
   * that have no corresponding in-memory state (e.g. after a process restart).
   * Call once at startup.
   */
  cleanupOrphans(): number {
    const orphans = this.store.list({ status: 'running' }).concat(this.store.list({ status: 'pending' }));
    let cleaned = 0;

    for (const task of orphans) {
      // If we have a controller for it, it's genuinely running — skip
      if (this.abortControllers.has(task.id)) continue;
      // If it's in the queue, it's genuinely pending — skip
      if (this.queue.some(t => t.id === task.id)) continue;

      // Orphaned — mark as failed
      this.store.markFailed(task.id, 'Orphaned after process restart');
      cleaned++;
    }

    if (cleaned > 0) {
      console.log(`[pool] Cleaned up ${cleaned} orphaned task(s)`);
    }
    return cleaned;
  }
}
