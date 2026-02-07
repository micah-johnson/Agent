/**
 * schedule_task tool — lets the agent create, list, delete, and toggle
 * recurring or one-off scheduled tasks.
 *
 * Factory pattern: createScheduleTaskTool(scheduler, context) returns a Tool
 * with channel/user context injected per-message via closure.
 */

import type { Scheduler, ScheduledJob } from '../scheduler/index.js';
import type { Tool, ToolInput, ToolResult } from './types.js';

export interface ScheduleTaskContext {
  channel_id: string;
  user_id: string;
}

export function createScheduleTaskTool(
  scheduler: Scheduler,
  context: ScheduleTaskContext,
): Tool {
  return {
    name: 'schedule_task',
    description:
      'Schedule recurring or one-off tasks. When a scheduled task fires, its message is processed ' +
      'through the normal agent pipeline as if a user sent it.\n\n' +
      'Actions:\n' +
      '- "create": Create a new scheduled job\n' +
      '- "list": List all scheduled jobs\n' +
      '- "delete": Delete a job by ID\n' +
      '- "toggle": Enable or disable a job by ID',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'delete', 'toggle'],
          description: 'The action to perform',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for the job (required for create)',
        },
        schedule_type: {
          type: 'string',
          enum: ['once', 'interval', 'cron'],
          description: 'Type of schedule (required for create)',
        },
        schedule_value: {
          type: 'string',
          description:
            'When to run (required for create). For "once": ISO date or relative like "in 2 hours", "tomorrow 9am". ' +
            'For "interval": duration like "30m", "1h", "6h", "1d". ' +
            'For "cron": cron expression like "0 9 * * 1-5" (weekdays at 9am).',
        },
        message: {
          type: 'string',
          description: 'The message the agent will process when the job fires (required for create)',
        },
        description: {
          type: 'string',
          description: 'Optional description of the job',
        },
        job_id: {
          type: 'string',
          description: 'Job ID (required for delete/toggle)',
        },
      },
      required: ['action'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      try {
        switch (input.action) {
          case 'create':
            return handleCreate(scheduler, context, input);
          case 'list':
            return handleList(scheduler);
          case 'delete':
            return handleDelete(scheduler, input);
          case 'toggle':
            return handleToggle(scheduler, input);
          default:
            return { success: false, error: `Unknown action: ${input.action}` };
        }
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    },
  };
}

// ─── Action handlers ─────────────────────────────────────────────────

function handleCreate(scheduler: Scheduler, context: ScheduleTaskContext, input: ToolInput): ToolResult {
  const { name, schedule_type, schedule_value, message, description } = input;

  if (!name) return { success: false, error: 'Missing required field: name' };
  if (!schedule_type) return { success: false, error: 'Missing required field: schedule_type' };
  if (!schedule_value) return { success: false, error: 'Missing required field: schedule_value' };
  if (!message) return { success: false, error: 'Missing required field: message' };

  if (!['once', 'interval', 'cron'].includes(schedule_type)) {
    return { success: false, error: `Invalid schedule_type: ${schedule_type}. Must be once, interval, or cron.` };
  }

  // Parse schedule_value into canonical form
  let parsedValue: string;
  try {
    parsedValue = parseScheduleValue(schedule_type, schedule_value);
  } catch (err: any) {
    return { success: false, error: `Invalid schedule_value: ${err?.message || err}` };
  }

  const job = scheduler.store.create({
    name,
    schedule_type,
    schedule_value: parsedValue,
    message,
    channel_id: context.channel_id,
    user_id: context.user_id,
    description,
  });

  return {
    success: true,
    output: formatJob(job, 'Created scheduled job'),
  };
}

function handleList(scheduler: Scheduler): ToolResult {
  const jobs = scheduler.store.list();
  if (jobs.length === 0) {
    return { success: true, output: 'No scheduled jobs.' };
  }

  const lines = jobs.map((job) => formatJobSummary(job));
  return {
    success: true,
    output: `${jobs.length} scheduled job(s):\n\n${lines.join('\n\n')}`,
  };
}

function handleDelete(scheduler: Scheduler, input: ToolInput): ToolResult {
  const { job_id } = input;
  if (!job_id) return { success: false, error: 'Missing required field: job_id' };

  const job = scheduler.store.get(job_id);
  if (!job) return { success: false, error: `Job not found: ${job_id}` };

  scheduler.store.delete(job_id);
  return { success: true, output: `Deleted job "${job.name}" (${job_id})` };
}

function handleToggle(scheduler: Scheduler, input: ToolInput): ToolResult {
  const { job_id } = input;
  if (!job_id) return { success: false, error: 'Missing required field: job_id' };

  const job = scheduler.store.get(job_id);
  if (!job) return { success: false, error: `Job not found: ${job_id}` };

  const newEnabled = job.enabled ? 0 : 1;
  const updated = scheduler.store.update(job_id, { enabled: newEnabled });
  const status = newEnabled ? 'enabled' : 'disabled';

  return { success: true, output: `Job "${updated!.name}" is now ${status}.` };
}

// ─── Schedule value parsing ──────────────────────────────────────────

function parseScheduleValue(type: string, value: string): string {
  switch (type) {
    case 'interval':
      return String(parseDuration(value));
    case 'once':
      return parseOnceValue(value);
    case 'cron':
      return value; // pass through as-is
    default:
      return value;
  }
}

/**
 * Parse a duration string like "30m", "1h", "6h", "1d", "2h30m" into milliseconds.
 */
function parseDuration(value: string): number {
  // If it's already a number (ms), pass through
  if (/^\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }

  let total = 0;
  const pattern = /(\d+)\s*(d|h|m|s)/gi;
  let match: RegExpExecArray | null;
  let matched = false;

  while ((match = pattern.exec(value)) !== null) {
    matched = true;
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case 'd':
        total += num * 86_400_000;
        break;
      case 'h':
        total += num * 3_600_000;
        break;
      case 'm':
        total += num * 60_000;
        break;
      case 's':
        total += num * 1_000;
        break;
    }
  }

  if (!matched) {
    throw new Error(`Cannot parse duration: "${value}". Use formats like "30m", "1h", "6h", "1d".`);
  }

  if (total <= 0) {
    throw new Error(`Duration must be positive, got ${total}ms from "${value}".`);
  }

  return total;
}

/**
 * Parse a "once" schedule value into an ISO date string.
 * Supports:
 *   - ISO strings (pass through)
 *   - "in N hours/minutes/days"
 *   - "tomorrow 9am" / "tomorrow 2pm"
 */
function parseOnceValue(value: string): string {
  const trimmed = value.trim();

  // Already ISO — validate and pass through
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) throw new Error(`Invalid ISO date: "${trimmed}"`);
    return d.toISOString();
  }

  // "in N <unit>" pattern
  const inMatch = trimmed.match(/^in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|seconds?|secs?)$/i);
  if (inMatch) {
    const num = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    let ms: number;
    if (unit.startsWith('sec')) ms = num * 1_000;
    else if (unit.startsWith('min')) ms = num * 60_000;
    else if (unit.startsWith('hr') || unit.startsWith('hour')) ms = num * 3_600_000;
    else if (unit.startsWith('day')) ms = num * 86_400_000;
    else throw new Error(`Unknown unit: ${unit}`);
    return new Date(Date.now() + ms).toISOString();
  }

  // "tomorrow Xam/pm"
  const tomorrowMatch = trimmed.match(/^tomorrow\s+(\d{1,2})\s*(am|pm)?$/i);
  if (tomorrowMatch) {
    let hour = parseInt(tomorrowMatch[1], 10);
    const ampm = (tomorrowMatch[2] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }

  // "today Xam/pm"
  const todayMatch = trimmed.match(/^today\s+(\d{1,2})\s*(am|pm)?$/i);
  if (todayMatch) {
    let hour = parseInt(todayMatch[1], 10);
    const ampm = (todayMatch[2] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    // If it's already past that time today, bump to tomorrow
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  // Fallback — try to parse as a date directly
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }

  throw new Error(
    `Cannot parse once schedule: "${trimmed}". Use an ISO date, "in N hours", "tomorrow 9am", etc.`,
  );
}

// ─── Formatting helpers ──────────────────────────────────────────────

function formatJob(job: ScheduledJob, prefix: string): string {
  const status = job.enabled ? '✅ enabled' : '⏸️ disabled';
  const lines = [
    `${prefix}:`,
    `  ID: ${job.id}`,
    `  Name: ${job.name}`,
    job.description ? `  Description: ${job.description}` : null,
    `  Type: ${job.schedule_type}`,
    `  Value: ${formatScheduleValue(job)}`,
    `  Message: "${job.message}"`,
    `  Status: ${status}`,
    `  Next run: ${job.next_run || 'N/A'}`,
    `  Channel: ${job.channel_id}`,
    `  Created: ${job.created_at}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function formatJobSummary(job: ScheduledJob): string {
  const status = job.enabled ? '✅' : '⏸️';
  const lastRun = job.last_run ? `last: ${job.last_run}` : 'never run';
  return (
    `${status} **${job.name}** (${job.id})\n` +
    `   ${job.schedule_type}: ${formatScheduleValue(job)} | ${lastRun} | runs: ${job.run_count}\n` +
    `   Next: ${job.next_run || 'N/A'} | Message: "${truncate(job.message, 60)}"`
  );
}

function formatScheduleValue(job: ScheduledJob): string {
  switch (job.schedule_type) {
    case 'interval': {
      const ms = parseInt(job.schedule_value, 10);
      if (ms >= 86_400_000) return `every ${ms / 86_400_000}d`;
      if (ms >= 3_600_000) return `every ${ms / 3_600_000}h`;
      if (ms >= 60_000) return `every ${ms / 60_000}m`;
      return `every ${ms / 1_000}s`;
    }
    case 'cron':
      return job.schedule_value;
    case 'once':
      return job.schedule_value;
    default:
      return job.schedule_value;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.substring(0, max - 3) + '...';
}
