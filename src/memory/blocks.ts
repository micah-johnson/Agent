/**
 * Structured memory blocks — typed, selectively-loaded knowledge.
 *
 * Directory structure:
 *   data/knowledge/
 *     _shared/
 *       persona.md              — Agent personality, behavioral rules
 *       projects/
 *         {project-name}.md     — Per-project knowledge, conventions, gotchas
 *     {userId}/
 *       preferences.md          — User preferences, working style
 *       patterns.md             — Learned behavioral patterns
 *
 * Block types:
 *   persona    — shared, always loaded
 *   preferences — personal, always loaded
 *   patterns   — personal, always loaded
 *   project    — shared, loaded selectively based on message context
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { dataDir } from '../workspace/path.js';
import { loadProjects } from '../workspace/registry.js';

const KNOWLEDGE_DIR = join(dataDir(), 'knowledge');

export interface MemoryBlock {
  type: 'persona' | 'preferences' | 'patterns' | 'project';
  scope: 'shared' | 'personal';
  name?: string;        // for project blocks
  content: string;
  path: string;
}

// In-memory cache keyed by file path
const cache = new Map<string, string>();

function readCached(filePath: string): string {
  const hit = cache.get(filePath);
  if (hit !== undefined) return hit;
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath, 'utf-8');
  cache.set(filePath, content);
  return content;
}

function writeCached(filePath: string, content: string): void {
  const dir = join(filePath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  cache.set(filePath, content);
}

// Path helpers
function sharedDir(): string { return join(KNOWLEDGE_DIR, '_shared'); }
function personaPath(): string { return join(sharedDir(), 'persona.md'); }
function projectsDir(): string { return join(sharedDir(), 'projects'); }
function projectPath(name: string): string { return join(projectsDir(), `${name}.md`); }
function userDir(userId: string): string { return join(KNOWLEDGE_DIR, userId); }
function preferencesPath(userId: string): string { return join(userDir(userId), 'preferences.md'); }
function patternsPath(userId: string): string { return join(userDir(userId), 'patterns.md'); }

/** Check if the new directory structure exists */
export function newStructureExists(): boolean {
  return existsSync(sharedDir());
}

/** Ensure the new directory structure exists (create dirs if needed) */
export function ensureStructure(userId?: string): void {
  for (const dir of [KNOWLEDGE_DIR, sharedDir(), projectsDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // Create persona.md if it doesn't exist
  if (!existsSync(personaPath())) {
    writeFileSync(personaPath(), '', 'utf-8');
  }
  if (userId) {
    const uDir = userDir(userId);
    if (!existsSync(uDir)) mkdirSync(uDir, { recursive: true });
    if (!existsSync(preferencesPath(userId))) writeFileSync(preferencesPath(userId), '', 'utf-8');
    if (!existsSync(patternsPath(userId))) writeFileSync(patternsPath(userId), '', 'utf-8');
  }
}

/** Detect which project names are relevant based on user message content */
export function detectRelevantProjects(message: string): string[] {
  if (!message) return [];
  const projects = loadProjects();
  const lower = message.toLowerCase();
  const relevant: string[] = [];

  for (const project of projects) {
    // Match project name
    if (lower.includes(project.name.toLowerCase())) {
      relevant.push(project.name);
      continue;
    }
    // Match project path segments (e.g. "Data-Engine" in a file path)
    const pathSegments = project.path.split('/').filter(s => s.length > 3);
    for (const seg of pathSegments.slice(-2)) { // last 2 path segments
      if (lower.includes(seg.toLowerCase())) {
        relevant.push(project.name);
        break;
      }
    }
  }

  return [...new Set(relevant)];
}

/** Get all available project block names */
function getProjectBlockNames(): string[] {
  const dir = projectsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => basename(f, '.md'));
}

/** Load all memory blocks relevant to this context */
export function loadMemoryBlocks(userId?: string, context?: {
  message?: string;
}): string {
  const parts: string[] = [];

  // 1. Always load persona (shared)
  const persona = readCached(personaPath());
  if (persona.trim()) {
    parts.push(`# Persona\n${persona.trim()}`);
  }

  // 2. Always load user preferences + patterns
  if (userId) {
    ensureStructure(userId);
    const prefs = readCached(preferencesPath(userId));
    if (prefs.trim()) {
      parts.push(`# Preferences\n${prefs.trim()}`);
    }
    const patterns = readCached(patternsPath(userId));
    if (patterns.trim()) {
      parts.push(`# Patterns\n${patterns.trim()}`);
    }
  }

  // 3. Conditionally load project blocks
  let relevantProjects: string[] = [];
  if (context?.message) {
    relevantProjects = detectRelevantProjects(context.message);
  }

  // If no specific projects detected, load all project blocks (they should be small)
  // If specific projects detected, only load those
  const projectNames = relevantProjects.length > 0
    ? relevantProjects
    : getProjectBlockNames();

  for (const name of projectNames) {
    const path = projectPath(name);
    const content = readCached(path);
    if (content.trim()) {
      parts.push(`# Project: ${name}\n${content.trim()}`);
    }
  }

  return parts.join('\n\n');
}

/** Append an entry to a specific block */
export function appendToBlock(
  blockType: string,
  entry: string,
  opts?: { userId?: string; scope?: 'shared' | 'personal'; projectName?: string },
): void {
  const path = resolveBlockPath(blockType, opts);
  let content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  content = content.trimEnd() + `\n- ${entry}\n`;
  writeCached(path, content);
}

/** Replace the entire content of a block */
export function replaceBlock(
  blockType: string,
  content: string,
  opts?: { userId?: string; scope?: 'shared' | 'personal'; projectName?: string },
): void {
  const path = resolveBlockPath(blockType, opts);
  writeCached(path, content);
}

/** Resolve which file path a block type maps to */
function resolveBlockPath(
  blockType: string,
  opts?: { userId?: string; scope?: 'shared' | 'personal'; projectName?: string },
): string {
  // Handle "project:name" syntax
  if (blockType.startsWith('project:')) {
    const name = blockType.slice('project:'.length);
    ensureStructure();
    return projectPath(name);
  }

  if (blockType === 'persona') {
    ensureStructure();
    return personaPath();
  }

  if (blockType === 'preferences' && opts?.userId) {
    ensureStructure(opts.userId);
    return preferencesPath(opts.userId);
  }

  if (blockType === 'patterns' && opts?.userId) {
    ensureStructure(opts.userId);
    return patternsPath(opts.userId);
  }

  // Fallback for unknown block types — use preferences
  if (opts?.userId) {
    ensureStructure(opts.userId);
    return preferencesPath(opts.userId);
  }

  ensureStructure();
  return personaPath();
}

/** Invalidate cache for a specific file (called after writes) */
export function invalidateCache(filePath?: string): void {
  if (filePath) {
    cache.delete(filePath);
  } else {
    cache.clear();
  }
}
