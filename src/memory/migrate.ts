/**
 * One-time migration from flat knowledge files to structured memory blocks.
 *
 * Old format:
 *   data/knowledge/_shared.md    — sections: Preferences, Projects, Decisions, Patterns
 *   data/knowledge/{userId}.md   — sections: Preferences, Decisions, Patterns
 *
 * New format:
 *   data/knowledge/_shared/persona.md
 *   data/knowledge/_shared/projects/{name}.md
 *   data/knowledge/{userId}/preferences.md
 *   data/knowledge/{userId}/patterns.md
 *
 * Non-destructive: old files are renamed with .bak suffix after migration.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { dataDir, dataPath } from '../workspace/path.js';

const KNOWLEDGE_DIR = join(dataDir(), 'knowledge');
const SHARED_PATH = join(KNOWLEDGE_DIR, '_shared.md');
const LEGACY_PATH = dataPath('knowledge.md');

/**
 * Parse a markdown file into sections.
 * Returns map of section name → content (without the heading).
 */
function parseSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split('\n');
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (currentSection) {
        sections.set(currentSection, currentContent.join('\n').trim());
      }
      currentSection = line.slice(2).trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentSection) {
    sections.set(currentSection, currentContent.join('\n').trim());
  }

  return sections;
}

/**
 * Extract project-related entries from the Projects section.
 * Each project entry starts with `- **name**` or mentions a known project.
 * Returns: { projectEntries: Map<projectName, entries[]>, otherEntries: string[] }
 */
function parseProjectEntries(projectsContent: string): {
  projectEntries: Map<string, string[]>;
  otherEntries: string[];
} {
  const projectEntries = new Map<string, string[]>();
  const otherEntries: string[] = [];

  const entries = projectsContent.split('\n').filter(l => l.startsWith('- '));

  for (const entry of entries) {
    // Check for **name** pattern at start of entry
    const boldMatch = entry.match(/^- \*\*([^*]+)\*\*/);
    if (boldMatch) {
      const name = boldMatch[1].toLowerCase().replace(/\s+/g, '-');
      const existing = projectEntries.get(name) || [];
      existing.push(entry);
      projectEntries.set(name, existing);
    } else {
      otherEntries.push(entry);
    }
  }

  return { projectEntries, otherEntries };
}

/**
 * Migrate from old flat-file format to new directory structure.
 *
 * Non-destructive: old files are renamed with .bak suffix after migration.
 */
export function migrateKnowledge(): boolean {
  // First handle the very old single-file format
  if (existsSync(LEGACY_PATH) && !existsSync(KNOWLEDGE_DIR)) {
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    renameSync(LEGACY_PATH, SHARED_PATH);
  }

  // Check if migration is needed: _shared.md exists but _shared/ directory doesn't
  if (!existsSync(SHARED_PATH)) return false;

  const sharedDir = join(KNOWLEDGE_DIR, '_shared');
  if (existsSync(sharedDir)) return false; // Already migrated

  console.log('[migrate] Migrating knowledge base to new structure...');

  // Create new directories
  const projectsDir = join(sharedDir, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  // Parse shared file
  const sharedContent = readFileSync(SHARED_PATH, 'utf-8');
  const sharedSections = parseSections(sharedContent);

  // Create persona.md from Preferences section (shared prefs are agent persona)
  const sharedPrefs = sharedSections.get('Preferences') || '';
  const personaFilePath = join(sharedDir, 'persona.md');
  writeFileSync(personaFilePath, sharedPrefs ? sharedPrefs + '\n' : '', 'utf-8');

  // Parse Projects section into per-project files
  const projectsContent = sharedSections.get('Projects') || '';
  if (projectsContent) {
    const { projectEntries, otherEntries } = parseProjectEntries(projectsContent);

    for (const [name, entries] of projectEntries) {
      writeFileSync(join(projectsDir, `${name}.md`), entries.join('\n') + '\n', 'utf-8');
    }

    // Other entries that don't belong to a specific project → add to persona
    if (otherEntries.length > 0) {
      const existing = readFileSync(personaFilePath, 'utf-8');
      writeFileSync(personaFilePath, existing.trimEnd() + '\n' + otherEntries.join('\n') + '\n', 'utf-8');
    }
  }

  // Patterns from shared → persona
  const sharedPatterns = sharedSections.get('Patterns') || '';
  if (sharedPatterns) {
    const existing = readFileSync(personaFilePath, 'utf-8');
    writeFileSync(personaFilePath, existing.trimEnd() + '\n\n## Patterns\n' + sharedPatterns + '\n', 'utf-8');
  }

  // Decisions from shared → also goes to persona
  const sharedDecisions = sharedSections.get('Decisions') || '';
  if (sharedDecisions.trim()) {
    const existing = readFileSync(personaFilePath, 'utf-8');
    writeFileSync(personaFilePath, existing.trimEnd() + '\n\n## Decisions\n' + sharedDecisions + '\n', 'utf-8');
  }

  // Rename old shared file
  renameSync(SHARED_PATH, SHARED_PATH + '.bak');

  // Migrate per-user files
  const files = readdirSync(KNOWLEDGE_DIR);
  for (const file of files) {
    if (file === '_shared' || file === '_shared.md.bak' || !file.endsWith('.md')) continue;

    const userId = basename(file, '.md');
    const userFilePath = join(KNOWLEDGE_DIR, file);
    const userContent = readFileSync(userFilePath, 'utf-8');
    const userSections = parseSections(userContent);

    const userDirPath = join(KNOWLEDGE_DIR, userId);
    mkdirSync(userDirPath, { recursive: true });

    // Preferences
    const prefs = userSections.get('Preferences') || '';
    writeFileSync(join(userDirPath, 'preferences.md'), prefs ? prefs + '\n' : '', 'utf-8');

    // Patterns (merge with Decisions since we're dropping the decisions block)
    let patterns = userSections.get('Patterns') || '';
    const decisions = userSections.get('Decisions') || '';
    if (decisions.trim()) {
      patterns = patterns.trimEnd() + '\n' + decisions;
    }
    writeFileSync(join(userDirPath, 'patterns.md'), patterns ? patterns.trim() + '\n' : '', 'utf-8');

    // Rename old user file
    renameSync(userFilePath, userFilePath + '.bak');
  }

  console.log('[migrate] ✓ Knowledge base migrated to new structure');
  return true;
}
