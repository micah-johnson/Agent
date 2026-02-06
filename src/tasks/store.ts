/**
 * Task store — synchronous CRUD over the tasks table
 * bun:sqlite is sync, so all operations are sync.
 */

import { getDb } from '../db/sqlite.js';

export interface Task {
  id: string;
  title: string;
  prompt: string;
  model: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: string | null;
  error: string | null;
  channel_id: string;
  user_id: string;
  iterations: number;
  tool_calls: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateTaskInput {
  title: string;
  prompt: string;
  model?: string;
  channel_id: string;
  user_id: string;
}

export class TaskStore {
  create(input: CreateTaskInput): Task {
    const db = getDb();
    const id = crypto.randomUUID();
    const model = input.model || 'claude-sonnet-4-5';

    db.run(
      `INSERT INTO tasks (id, title, prompt, model, channel_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.title, input.prompt, model, input.channel_id, input.user_id],
    );

    return this.get(id)!;
  }

  get(id: string): Task | null {
    const db = getDb();
    return db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null;
  }

  list(options?: { status?: string; limit?: number }): Task[] {
    const db = getDb();
    const limit = options?.limit || 20;

    if (options?.status) {
      return db
        .query('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(options.status, limit) as Task[];
    }

    return db
      .query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Task[];
  }

  markRunning(id: string): void {
    const db = getDb();
    db.run(
      `UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?`,
      [id],
    );
  }

  markCompleted(id: string, result: string, stats: { iterations: number; toolCalls: number }): void {
    const db = getDb();
    db.run(
      `UPDATE tasks SET status = 'completed', result = ?, iterations = ?, tool_calls = ?,
       completed_at = datetime('now') WHERE id = ?`,
      [result, stats.iterations, stats.toolCalls, id],
    );
  }

  markFailed(id: string, error: string): void {
    const db = getDb();
    db.run(
      `UPDATE tasks SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`,
      [error, id],
    );
  }
}
