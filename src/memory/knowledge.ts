/**
 * Knowledge base manager — reads and writes data/knowledge.md
 *
 * The knowledge file is a structured markdown document with sections
 * (Preferences, Projects, Decisions, Patterns). It's loaded into the
 * system prompt on every request so Agent always has context.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dataDir, dataPath } from '../workspace/path.js';

const KNOWLEDGE_DIR = dataDir();
const KNOWLEDGE_PATH = dataPath('knowledge.md');

const INITIAL_CONTENT = `# Preferences

# Projects

# Decisions

# Patterns
`;

function ensureFile(): void {
  if (!existsSync(KNOWLEDGE_DIR)) {
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }
  if (!existsSync(KNOWLEDGE_PATH)) {
    writeFileSync(KNOWLEDGE_PATH, INITIAL_CONTENT, 'utf-8');
  }
}

// In-memory cache — avoids disk read on every message
let knowledgeCache: string | null = null;

/**
 * Read the full knowledge.md contents.
 * Cached in memory; invalidated on write.
 */
export function loadKnowledge(): string {
  if (knowledgeCache !== null) return knowledgeCache;
  ensureFile();
  knowledgeCache = readFileSync(KNOWLEDGE_PATH, 'utf-8');
  return knowledgeCache;
}

/**
 * Append an entry under a section heading.
 * Creates the section if it doesn't exist.
 */
export function appendKnowledge(section: string, entry: string): void {
  ensureFile();
  let content = readFileSync(KNOWLEDGE_PATH, 'utf-8');
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

  writeFileSync(KNOWLEDGE_PATH, content, 'utf-8');
  knowledgeCache = content;
}

/**
 * Replace the entire content of a section.
 */
export function replaceKnowledgeSection(section: string, newContent: string): void {
  ensureFile();
  let content = readFileSync(KNOWLEDGE_PATH, 'utf-8');
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

  writeFileSync(KNOWLEDGE_PATH, content, 'utf-8');
  knowledgeCache = content;
}
