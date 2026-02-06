/**
 * Worker pool — concurrency-limited execution of sub-agent tasks
 *
 * submit() is fire-and-forget. Tasks run immediately if under the
 * concurrency limit, otherwise they queue. On completion, the next
 * queued task is drained automatically.
 */

import { EventEmitter } from 'events';
import { runSubAgent } from './worker.js';
import type { Task } from '../tasks/store.js';
import type { TaskStore } from '../tasks/store.js';

const MAX_CONCURRENCY = 3;

export class WorkerPool extends EventEmitter {
  private running: Map<string, Promise<void>> = new Map();
  private queue: Task[] = [];
  private store: TaskStore;
  private apiKey: string;

  constructor(store: TaskStore, apiKey: string) {
    super();
    this.store = store;
    this.apiKey = apiKey;
  }

  submit(task: Task): void {
    if (this.running.size < MAX_CONCURRENCY) {
      this.run(task);
    } else {
      this.queue.push(task);
    }
  }

  private run(task: Task): void {
    this.store.markRunning(task.id);

    const promise = this.execute(task).finally(() => {
      this.running.delete(task.id);
      this.drain();
    });

    this.running.set(task.id, promise);
  }

  private async execute(task: Task): Promise<void> {
    try {
      const result = await runSubAgent(task, this.apiKey);

      this.store.markCompleted(task.id, result.text, {
        iterations: result.iterations,
        toolCalls: result.toolCalls,
      });

      this.emit('task:complete', task.id);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.store.markFailed(task.id, msg);
      this.emit('task:complete', task.id);
    }
  }

  private drain(): void {
    while (this.running.size < MAX_CONCURRENCY && this.queue.length > 0) {
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
}
