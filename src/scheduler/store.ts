/**
 * SQLite-backed storage for scheduled jobs.
 *
 * Persists jobs so they survive restarts. Uses the shared
 * bun:sqlite database from src/db/sqlite.ts.
 */

import { getDb } from '../db/sqlite.js';
import type { Database } from 'bun:sqlite';

export interface ScheduledJob {
  id: string;
  name: string;
  description: string | null;
  schedule_type: 'once' | 'interval' | 'cron';
  schedule_value: string;
  message: string;
  channel_id: string;
  user_id: string;
  enabled: number;
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  created_at: string;
}

export type CreateJobInput = Pick<
  ScheduledJob,
  'name' | 'schedule_type' | 'schedule_value' | 'message' | 'channel_id' | 'user_id'
> & { description?: string };

export class SchedulerStore {
  private db: Database;

  constructor() {
    this.db = getDb();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        message TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        next_run TEXT,
        run_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  create(input: CreateJobInput): ScheduledJob {
    const id = crypto.randomUUID();
    const nextRun = computeNextRun(input.schedule_type, input.schedule_value);

    this.db
      .prepare(
        `INSERT INTO scheduled_jobs (id, name, description, schedule_type, schedule_value, message, channel_id, user_id, next_run)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        input.schedule_type,
        input.schedule_value,
        input.message,
        input.channel_id,
        input.user_id,
        nextRun,
      );

    return this.get(id)!;
  }

  get(id: string): ScheduledJob | null {
    return (this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as ScheduledJob | null) ?? null;
  }

  list(): ScheduledJob[] {
    return this.db.prepare('SELECT * FROM scheduled_jobs ORDER BY created_at DESC').all() as ScheduledJob[];
  }

  listEnabled(): ScheduledJob[] {
    return this.db
      .prepare('SELECT * FROM scheduled_jobs WHERE enabled = 1 ORDER BY next_run ASC')
      .all() as ScheduledJob[];
  }

  update(
    id: string,
    fields: Partial<
      Pick<ScheduledJob, 'name' | 'description' | 'enabled' | 'schedule_type' | 'schedule_value' | 'message' | 'next_run'>
    >,
  ): ScheduledJob | null {
    const existing = this.get(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }

    if (sets.length === 0) return existing;

    values.push(id);
    this.db.prepare(`UPDATE scheduled_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id);
    return result.changes > 0;
  }

  markRun(id: string): void {
    const job = this.get(id);
    if (!job) return;

    const now = new Date().toISOString();

    if (job.schedule_type === 'once') {
      // One-shot — disable after running
      this.db
        .prepare('UPDATE scheduled_jobs SET last_run = ?, run_count = run_count + 1, enabled = 0 WHERE id = ?')
        .run(now, id);
    } else {
      const nextRun = computeNextRun(job.schedule_type, job.schedule_value);
      this.db
        .prepare('UPDATE scheduled_jobs SET last_run = ?, run_count = run_count + 1, next_run = ? WHERE id = ?')
        .run(now, nextRun, id);
    }
  }
}

// ─── Next-run computation ────────────────────────────────────────────

export function computeNextRun(scheduleType: string, scheduleValue: string): string {
  switch (scheduleType) {
    case 'once':
      return scheduleValue; // Already an ISO date string
    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      return new Date(Date.now() + ms).toISOString();
    }
    case 'cron':
      return computeNextCron(scheduleValue);
    default:
      return new Date(Date.now() + 60_000).toISOString(); // fallback: 1 min
  }
}

// ─── Simple cron parser ──────────────────────────────────────────────
// Handles: * (any), specific numbers, */N (every N), ranges like 1-5,
// comma-separated lists like 1,3,5

interface CronField {
  type: 'any' | 'value' | 'step' | 'range' | 'list';
  value?: number;
  step?: number;
  from?: number;
  to?: number;
  values?: number[];
}

function parseCronField(field: string): CronField {
  if (field === '*') return { type: 'any' };

  // */N — every N
  if (field.startsWith('*/')) {
    return { type: 'step', step: parseInt(field.slice(2), 10) };
  }

  // Comma-separated list (e.g., "1,3,5")
  if (field.includes(',')) {
    const values = field.split(',').map((v) => parseInt(v.trim(), 10));
    return { type: 'list', values };
  }

  // Range (e.g., "1-5")
  if (field.includes('-')) {
    const [from, to] = field.split('-').map((v) => parseInt(v.trim(), 10));
    return { type: 'range', from, to };
  }

  // Specific number
  return { type: 'value', value: parseInt(field, 10) };
}

function fieldMatches(field: CronField, value: number): boolean {
  switch (field.type) {
    case 'any':
      return true;
    case 'value':
      return value === field.value;
    case 'step':
      return value % field.step! === 0;
    case 'range':
      return value >= field.from! && value <= field.to!;
    case 'list':
      return field.values!.includes(value);
    default:
      return false;
  }
}

function cronDateMatches(
  minute: CronField,
  hour: CronField,
  day: CronField,
  month: CronField,
  weekday: CronField,
  date: Date,
): boolean {
  return (
    fieldMatches(minute, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(day, date.getDate()) &&
    fieldMatches(month, date.getMonth() + 1) && // months are 1-12 in cron
    fieldMatches(weekday, date.getDay()) // 0=Sunday
  );
}

function computeNextCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    // Fall back to 1 hour if the expression is malformed
    return new Date(Date.now() + 3_600_000).toISOString();
  }

  const [minuteStr, hourStr, dayStr, monthStr, weekdayStr] = parts;
  const minute = parseCronField(minuteStr);
  const hour = parseCronField(hourStr);
  const day = parseCronField(dayStr);
  const month = parseCronField(monthStr);
  const weekday = parseCronField(weekdayStr);

  // Start from the next minute and scan forward up to 366 days
  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // always at least 1 min in the future

  const limit = 366 * 24 * 60; // max minutes to scan
  for (let i = 0; i < limit; i++) {
    if (cronDateMatches(minute, hour, day, month, weekday, candidate)) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // Couldn't find a match — fallback
  return new Date(Date.now() + 3_600_000).toISOString();
}
