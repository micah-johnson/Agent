/**
 * File watcher — uses chokidar to watch registered projects
 * and re-index on changes. Debounces rapid changes per project.
 *
 * On WSL2 with /mnt/c/ mounts, native fs events don't work.
 * Uses polling mode with a longer interval to avoid CPU overhead.
 */

import { watch, type FSWatcher } from 'chokidar';
import { indexProject } from './indexer.js';
import type { Project } from './registry.js';

const DEBOUNCE_MS = 3000;
const POLL_INTERVAL = 10000; // 10s polling for WSL2 compat

const IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.cache/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/*.sqlite*',
  '**/*.sqlite-shm',
  '**/*.sqlite-wal',
];

const watchers: FSWatcher[] = [];
const debounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Start watching all registered projects.
 * Runs asynchronously — does not block the caller.
 */
export function startWatching(projects: Project[]): void {
  // Start watchers in next tick so they don't block startup
  setTimeout(() => {
    for (const project of projects) {
      try {
        const watcher = watch(project.path, {
          ignored: IGNORED,
          ignoreInitial: true,
          persistent: true,
          depth: 4,
          usePolling: true,
          interval: POLL_INTERVAL,
        });

        const scheduleReindex = () => {
          const existing = debounceTimers.get(project.name);
          if (existing) clearTimeout(existing);

          debounceTimers.set(
            project.name,
            setTimeout(() => {
              debounceTimers.delete(project.name);
              console.log(`[watcher] Re-indexing project: ${project.name}`);
              try {
                indexProject(project);
              } catch (err: any) {
                console.error(
                  `[watcher] Re-index failed for ${project.name}: ${err?.message || err}`,
                );
              }
            }, DEBOUNCE_MS),
          );
        };

        watcher.on('add', scheduleReindex);
        watcher.on('unlink', scheduleReindex);
        watcher.on('change', scheduleReindex);
        watcher.on('addDir', scheduleReindex);
        watcher.on('unlinkDir', scheduleReindex);

        watcher.on('error', (err) => {
          console.error(`[watcher] Error watching ${project.name}: ${err.message}`);
        });

        watchers.push(watcher);
      } catch (err: any) {
        console.error(`[watcher] Failed to start watching ${project.name}: ${err?.message || err}`);
      }
    }
  }, 100);
}

/**
 * Stop all watchers for clean shutdown.
 */
export async function stopWatching(): Promise<void> {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  await Promise.all(watchers.map((w) => w.close()));
  watchers.length = 0;
}
