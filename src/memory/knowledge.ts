/**
 * Knowledge base manager — multi-user support with shared + per-user files.
 *
 * Directory structure:
 *   data/knowledge/
 *     _shared.md    — team/project knowledge (visible to all users)
 *     {userId}.md   — per-user knowledge (preferences, personal patterns)
 *
 * On first load, if data/knowledge.md exists and data/knowledge/ doesn't,
 * the old file is migrated to data/knowledge/_shared.md automatically.
 *
 * loadKnowledge(userId?) returns shared content, plus personal content
 * when a userId is provided. The combined string is injected into the
 * system prompt under ## Knowledge Base.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { dataDir, dataPath } from '../workspace/path.js';

const KNOWLEDGE_DIR = join(dataDir(), 'knowledge');
const SHARED_PATH = join(KNOWLEDGE_DIR, '_shared.md');
const LEGACY_PATH = dataPath('knowledge.md');

const INITIAL_SHARED = `# Preferences

# Projects

# Decisions

# Patterns
`;

const INITIAL_PERSONAL = `# Preferences

# Decisions

# Patterns
`;

/** Migrate legacy single-file knowledge.md → knowledge/_shared.md */
function migrateLegacy(): void {
  if (existsSync(LEGACY_PATH) && !existsSync(KNOWLEDGE_DIR)) {
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    renameSync(LEGACY_PATH, SHARED_PATH);
  }
}

function ensureDir(): void {
  migrateLegacy();
  if (!existsSync(KNOWLEDGE_DIR)) {
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }
}

function ensureShared(): void {
  ensureDir();
  if (!existsSync(SHARED_PATH)) {
    writeFileSync(SHARED_PATH, INITIAL_SHARED, 'utf-8');
  }
}

function userPath(userId: string): string {
  return join(KNOWLEDGE_DIR, `${userId}.md`);
}

function ensureUser(userId: string): void {
  ensureDir();
  const p = userPath(userId);
  if (!existsSync(p)) {
    writeFileSync(p, INITIAL_PERSONAL, 'utf-8');
  }
}

// In-memory cache keyed by file path — avoids disk reads on every message
const cache = new Map<string, string>();

function readCached(filePath: string): string {
  const hit = cache.get(filePath);
  if (hit !== undefined) return hit;
  const content = readFileSync(filePath, 'utf-8');
  cache.set(filePath, content);
  return content;
}

function writeCached(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8');
  cache.set(filePath, content);
}

/**
 * Resolve which file to operate on based on scope and userId.
 * Returns the absolute path and ensures the file exists.
 */
function resolveTarget(opts?: { userId?: string; scope?: 'shared' | 'personal' }): string {
  const userId = opts?.userId;
  const scope = opts?.scope ?? (userId ? 'personal' : 'shared');

  if (scope === 'personal' && userId) {
    ensureUser(userId);
    return userPath(userId);
  }
  ensureShared();
  return SHARED_PATH;
}

/**
 * Read the combined knowledge for a request.
 *
 * - Always includes _shared.md
 * - If userId is provided and a personal file exists, appends it
 *   after a separator so the model sees both.
 */
export function loadKnowledge(userId?: string): string {
  ensureShared();
  const shared = readCached(SHARED_PATH);

  if (!userId) return shared;

  const personal = userPath(userId);
  if (!existsSync(personal)) return shared;

  const personalContent = readCached(personal);
  if (!personalContent.trim()) return shared;

  return shared.trimEnd() + '\n\n---\n\n' + personalContent;
}

/**
 * Append an entry under a section heading.
 * Creates the section if it doesn't exist.
 */
export function appendKnowledge(
  section: string,
  entry: string,
  opts?: { userId?: string; scope?: 'shared' | 'personal' },
): void {
  const targetPath = resolveTarget(opts);
  let content = readFileSync(targetPath, 'utf-8');
  const heading = `# ${section}`;
  const headingIndex = content.indexOf(heading);

  if (headingIndex === -1) {
    // Section doesn't exist — append at end
    content = content.trimEnd() + `\n\n${heading}\n- ${entry}\n`;
  } else {
    // Find the end of this section (next heading or EOF)
    const afterHeading = headingIndex + heading.length;
    const nextHeading = content.indexOf('\n# ', afterHeading);
    const insertAt = nextHeading === -1 ? content.length : nextHeading;

    // Insert the entry before the next section
    const before = content.slice(0, insertAt).trimEnd();
    const after = content.slice(insertAt);
    content = before + `\n- ${entry}` + after;
  }

  writeCached(targetPath, content);
}

/**
 * Replace the entire content of a section.
 */
export function replaceKnowledgeSection(
  section: string,
  newContent: string,
  opts?: { userId?: string; scope?: 'shared' | 'personal' },
): void {
  const targetPath = resolveTarget(opts);
  let content = readFileSync(targetPath, 'utf-8');
  const heading = `# ${section}`;
  const headingIndex = content.indexOf(heading);

  if (headingIndex === -1) {
    // Section doesn't exist — append
    content = content.trimEnd() + `\n\n${heading}\n${newContent}\n`;
  } else {
    const afterHeading = headingIndex + heading.length;
    const nextHeading = content.indexOf('\n# ', afterHeading);
    const sectionEnd = nextHeading === -1 ? content.length : nextHeading;

    content = content.slice(0, afterHeading) + '\n' + newContent + '\n' + content.slice(sectionEnd);
  }

  writeCached(targetPath, content);
}
