/**
 * Orchestrator — glue layer connecting TaskStore, WorkerPool, and Slack
 *
 * Listens for task:complete events from the pool and posts results
 * back to the user's Slack DM.
 */

import type { WebClient } from '@slack/web-api';
import { TaskStore } from '../tasks/store.js';
import { WorkerPool } from '../subagent/pool.js';

const MAX_SLACK_LENGTH = 2000;

export class Orchestrator {
  readonly store: TaskStore;
  readonly pool: WorkerPool;
  private slackClient: WebClient | null = null;

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

  private async onTaskComplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || !this.slackClient) return;

    let message: string;
    if (task.status === 'completed') {
      let result = task.result || 'Task completed.';
      if (result.length > MAX_SLACK_LENGTH) {
        result = result.substring(0, MAX_SLACK_LENGTH - 20) + '\n... (truncated)';
      }
      message = `*Task complete:* ${task.title}\n\n${result}`;
    } else {
      message = `*Task failed:* ${task.title}\n\nError: ${task.error || 'Unknown error'}`;
    }

    try {
      await this.slackClient.chat.postMessage({
        channel: task.channel_id,
        text: message,
      });
    } catch (error) {
      console.error(`[orchestrator] Failed to post result for task ${taskId}:`, error);
    }
  }
}
