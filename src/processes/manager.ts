/**
 * Background process manager — singleton that manages long-running child processes.
 *
 * Processes are spawned via /bin/bash with stdout+stderr captured to log files
 * in /tmp/agent-processes/. The manager tracks status, supports graceful stop
 * (SIGTERM → SIGKILL after 5s), and provides a context summary for system prompt
 * injection so the agent always knows what's running.
 */

import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync, appendFileSync, readFileSync } from 'fs';

const LOG_DIR = '/tmp/agent-processes';
const MAX_PROCESSES = 5;
const MAX_LOG_OUTPUT = 50_000; // chars
const CLEANUP_AGE_MS = 30 * 60 * 1000; // 30 minutes

export interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: Date;
  logFile: string;
  process: ChildProcess;
  status: 'running' | 'exited';
  exitCode?: number | null;
  label?: string;
}

class ProcessManager {
  private processes: Map<string, ManagedProcess> = new Map();
  private counter = 0;
  private logDirCreated = false;

  private ensureLogDir(): void {
    if (!this.logDirCreated) {
      try {
        mkdirSync(LOG_DIR, { recursive: true });
      } catch {
        // may already exist
      }
      this.logDirCreated = true;
    }
  }

  /** Start a new background process. */
  start(command: string, options?: { cwd?: string; label?: string }): ManagedProcess {
    this.cleanup();
    this.ensureLogDir();

    // Enforce max concurrent running processes
    const running = Array.from(this.processes.values()).filter((p) => p.status === 'running');
    if (running.length >= MAX_PROCESSES) {
      throw new Error(
        `Max concurrent processes (${MAX_PROCESSES}) reached. Stop a running process first.`,
      );
    }

    this.counter++;
    const id = `proc_${this.counter}`;
    const cwd = options?.cwd || process.cwd();
    const logFile = `${LOG_DIR}/${id}.log`;

    // Write initial log header
    try {
      appendFileSync(logFile, `[agent] Starting: ${command}\n[agent] cwd: ${cwd}\n\n`);
    } catch {
      // best-effort
    }

    const child = spawn(command, [], {
      shell: '/bin/bash',
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      cwd,
    });

    const managed: ManagedProcess = {
      id,
      command,
      cwd,
      pid: child.pid!,
      startedAt: new Date(),
      logFile,
      process: child,
      status: 'running',
      label: options?.label,
    };

    // Stream stdout to log file
    child.stdout?.on('data', (data: Buffer) => {
      try {
        appendFileSync(logFile, data);
      } catch {
        // best-effort
      }
    });

    // Stream stderr to log file
    child.stderr?.on('data', (data: Buffer) => {
      try {
        appendFileSync(logFile, data);
      } catch {
        // best-effort
      }
    });

    // Handle process exit
    child.on('exit', (code) => {
      managed.status = 'exited';
      managed.exitCode = code;
      try {
        appendFileSync(logFile, `\n[agent] Process exited with code ${code}\n`);
      } catch {
        // best-effort
      }
    });

    // Handle spawn errors (command not found, permission denied, etc.)
    child.on('error', (err) => {
      managed.status = 'exited';
      managed.exitCode = -1;
      try {
        appendFileSync(logFile, `\n[agent] Process error: ${err.message}\n`);
      } catch {
        // best-effort
      }
    });

    this.processes.set(id, managed);
    return managed;
  }

  /** List all tracked processes (running + recently exited). */
  list(): ManagedProcess[] {
    this.cleanup();
    return Array.from(this.processes.values());
  }

  /** Stop a process by ID. Sends SIGTERM first, then SIGKILL after 5 seconds. */
  stop(id: string): { success: boolean; error?: string } {
    const proc = this.processes.get(id);
    if (!proc) {
      return { success: false, error: `Process ${id} not found` };
    }
    if (proc.status === 'exited') {
      return { success: true, error: `Process ${id} already exited (code ${proc.exitCode})` };
    }

    try {
      proc.process.kill('SIGTERM');
    } catch (err: any) {
      return { success: false, error: `Failed to send SIGTERM: ${err.message}` };
    }

    // Schedule SIGKILL fallback after 5 seconds
    setTimeout(() => {
      if (proc.status === 'running') {
        try {
          proc.process.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
    }, 5000);

    return { success: true };
  }

  /** Get log output for a process (last N lines). */
  logs(id: string, options?: { tail?: number }): { success: boolean; output?: string; error?: string } {
    const proc = this.processes.get(id);
    if (!proc) {
      return { success: false, error: `Process ${id} not found` };
    }

    const tail = options?.tail ?? 100;

    try {
      if (!existsSync(proc.logFile)) {
        return { success: true, output: '(no output yet)' };
      }

      const content = readFileSync(proc.logFile, 'utf-8');
      if (!content) {
        return { success: true, output: '(no output yet)' };
      }

      const lines = content.split('\n');
      const selected = lines.slice(-tail).join('\n');

      // Cap at max output length
      const output = selected.length > MAX_LOG_OUTPUT
        ? selected.slice(-MAX_LOG_OUTPUT)
        : selected;

      return { success: true, output };
    } catch (err: any) {
      return { success: false, error: `Failed to read log: ${err.message}` };
    }
  }

  /** Check if a specific process is still running. */
  check(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  /** Get a markdown summary of active processes for system prompt injection. */
  getContextSummary(): string {
    const all = Array.from(this.processes.values());
    if (all.length === 0) return '';

    const rows = all.map((p) => {
      const label = p.label || '—';
      const uptime = p.status === 'running' ? formatUptime(Date.now() - p.startedAt.getTime()) : '—';
      const status = p.status === 'running' ? 'running' : `exited (${p.exitCode})`;
      const cmd = p.command.length > 40 ? p.command.substring(0, 37) + '...' : p.command;
      return `| ${p.id} | ${label} | ${cmd} | ${p.pid} | ${uptime} | ${status} |`;
    });

    return [
      '## Active Background Processes',
      '',
      '| ID | Label | Command | PID | Uptime | Status |',
      '|------|---------|---------------------------|-------|---------|---------|',
      ...rows,
    ].join('\n');
  }

  /** Remove exited processes older than 30 minutes from the map. */
  cleanup(): void {
    const now = Date.now();
    for (const [id, proc] of this.processes) {
      if (proc.status === 'exited' && now - proc.startedAt.getTime() > CLEANUP_AGE_MS) {
        this.processes.delete(id);
      }
    }
  }
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

let instance: ProcessManager | null = null;

export function getProcessManager(): ProcessManager {
  if (!instance) instance = new ProcessManager();
  return instance;
}
