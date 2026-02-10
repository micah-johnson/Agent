/**
 * Project registry — loads projects.json from workspace config
 */

import { readFileSync, existsSync } from 'fs';
import { configPath } from './path.js';

const CONFIG_PATH = configPath('projects.json');

export interface Project {
  name: string;
  path: string;
  description: string;
  language: string;
  maxDepth?: number;    // Override global MAX_TREE_DEPTH (default: 4)
  ignore?: string[];    // Additional directories to skip (beyond SKIP_DIRS)
}

export function loadProjects(): Project[] {
  if (!existsSync(CONFIG_PATH)) {
    return [];
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Support both bare array and { projects: [] } formats
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.projects) ? parsed.projects : [];
    return arr as Project[];
  } catch {
    console.error('[workspace] Failed to parse projects.json');
    return [];
  }
}
