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
}

export function loadProjects(): Project[] {
  if (!existsSync(CONFIG_PATH)) {
    return [];
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as Project[];
  } catch {
    console.error('[workspace] Failed to parse projects.json');
    return [];
  }
}
