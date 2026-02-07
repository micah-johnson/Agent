/**
 * Scheduler engine — checks for due jobs on a 30-second interval
 * and fires them through a callback.
 *
 * Usage:
 *   const scheduler = getScheduler();
 *   scheduler.start((job) => { ... handle fired job ... });
 *
 * The singleton pattern mirrors getDb() so both index.ts and
 * process-message.ts can share the same instance.
 */

import { SchedulerStore, type ScheduledJob } from './store.js';

export type { ScheduledJob } from './store.js';

const TICK_INTERVAL_MS = 30_000; // 30 seconds

export class Scheduler {
  readonly store: SchedulerStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onJobFire: ((job: ScheduledJob) => void) | null = null;

  constructor() {
    this.store = new SchedulerStore();
  }

  /** Start the scheduler loop — checks every 30 seconds */
  start(onFire: (job: ScheduledJob) => void): void {
    this.onJobFire = onFire;

    // Run an initial tick right away so jobs that were due during
    // downtime fire promptly after startup.
    this.tick();

    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    // Allow the process to exit even if the timer is still running
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onJobFire = null;
  }

  /** Check for due jobs and fire them */
  private tick(): void {
    if (!this.onJobFire) return;

    const now = new Date().toISOString();
    const enabledJobs = this.store.listEnabled();

    for (const job of enabledJobs) {
      if (!job.next_run) continue;
      if (job.next_run > now) continue;

      try {
        this.onJobFire(job);
        this.store.markRun(job.id);
      } catch (err: any) {
        // Per-job catch so one failure doesn't stop others
        console.error(`[scheduler] Error firing job ${job.id} ("${job.name}"): ${err?.message || err}`);
      }
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────

let instance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!instance) {
    instance = new Scheduler();
  }
  return instance;
}
