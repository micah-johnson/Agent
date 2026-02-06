/**
 * Project registry — loads config/projects.json
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_PATH = join(import.meta.dir, '../../config/projects.json');

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
    console.error('[workspace] Failed to parse config/projects.json');
    return [];
  }
}
