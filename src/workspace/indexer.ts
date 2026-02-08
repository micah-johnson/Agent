/**
 * Workspace indexer — scans registered projects, builds file trees,
 * reads key files, runs git commands, and stores summaries in SQLite.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getDb } from '../db/sqlite.js';
import { loadProjects, type Project } from './registry.js';

export interface ProjectSummary {
  projectName: string;
  treeText: string;
  keyFiles: Record<string, string>;
  gitLog: string;
  gitBranch: string;
  dependencies: Record<string, string>;
  indexedAt: string;
}

// Directories to always skip when building file tree
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache',
  '.turbo', 'coverage', '.nyc_output', '__pycache__', '.venv',
]);

// Key files to read and store content of
const KEY_FILES = [
  'package.json', 'README.md', 'readme.md', 'tsconfig.json',
  'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile',
  'Dockerfile', 'docker-compose.yml', '.env.example',
];

const MAX_KEY_FILE_LINES = 200;
const MAX_TREE_DEPTH = 4;

/**
 * Build an indented file tree string for a project directory.
 */
function buildTree(dir: string, prefix: string = '', depth: number = 0): string {
  if (depth > MAX_TREE_DEPTH) return '';

  let result = '';
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return '';
  }

  // Separate dirs and files
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') && depth === 0 && entry !== '.env.example') continue;
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) dirs.push(entry);
      } else {
        files.push(entry);
      }
    } catch {
      // skip inaccessible
    }
  }

  for (const d of dirs) {
    result += `${prefix}${d}/\n`;
    result += buildTree(join(dir, d), prefix + '  ', depth + 1);
  }

  for (const f of files) {
    result += `${prefix}${f}\n`;
  }

  return result;
}

/**
 * Read key files from a project, truncating to MAX_KEY_FILE_LINES.
 */
function readKeyFiles(projectPath: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const filename of KEY_FILES) {
    const filePath = join(projectPath, filename);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      if (lines.length > MAX_KEY_FILE_LINES) {
        result[filename] = lines.slice(0, MAX_KEY_FILE_LINES).join('\n') + '\n... (truncated)';
      } else {
        result[filename] = content;
      }
    } catch {
      // skip unreadable
    }
  }

  return result;
}

/**
 * Run git commands in a project directory.
 */
function getGitInfo(projectPath: string): { log: string; branch: string } {
  const opts = { cwd: projectPath, encoding: 'utf-8' as const, timeout: 5000 };

  let log = '';
  let branch = '';

  try {
    log = execSync('git log --oneline -20', opts).trim();
  } catch {
    log = '(not a git repo or git not available)';
  }

  try {
    branch = execSync('git branch --show-current', opts).trim();
  } catch {
    branch = 'unknown';
  }

  return { log, branch };
}

/**
 * Parse dependencies from package.json.
 */
function parseDependencies(keyFiles: Record<string, string>): Record<string, string> {
  const pkgJson = keyFiles['package.json'];
  if (!pkgJson) return {};

  try {
    const pkg = JSON.parse(pkgJson);
    return {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
  } catch {
    return {};
  }
}

/**
 * Index a single project — build tree, read files, run git, store in SQLite.
 */
export function indexProject(project: Project): void {
  if (!existsSync(project.path)) {
    console.error(`[workspace] Project path not found: ${project.path}`);
    return;
  }

  const treeText = buildTree(project.path);
  const keyFiles = readKeyFiles(project.path);
  const git = getGitInfo(project.path);
  const dependencies = parseDependencies(keyFiles);

  const db = getDb();
  db.run(
    `INSERT INTO project_summaries (project_name, tree_text, key_files, git_log, git_branch, dependencies, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_name) DO UPDATE SET
       tree_text = excluded.tree_text,
       key_files = excluded.key_files,
       git_log = excluded.git_log,
       git_branch = excluded.git_branch,
       dependencies = excluded.dependencies,
       indexed_at = excluded.indexed_at`,
    [
      project.name,
      treeText,
      JSON.stringify(keyFiles),
      git.log,
      git.branch,
      JSON.stringify(dependencies),
    ],
  );
}

/**
 * Get the stored summary for a project.
 */
export function getProjectSummary(projectName: string): ProjectSummary | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM project_summaries WHERE project_name = ?')
    .get(projectName) as any;

  if (!row) return null;

  return {
    projectName: row.project_name,
    treeText: row.tree_text,
    keyFiles: JSON.parse(row.key_files || '{}'),
    gitLog: row.git_log,
    gitBranch: row.git_branch,
    dependencies: JSON.parse(row.dependencies || '{}'),
    indexedAt: row.indexed_at,
  };
}

/**
 * Get all project summaries.
 */
export function getAllProjectSummaries(): ProjectSummary[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM project_summaries').all() as any[];
  return rows.map((row) => ({
    projectName: row.project_name,
    treeText: row.tree_text,
    keyFiles: JSON.parse(row.key_files || '{}'),
    gitLog: row.git_log,
    gitBranch: row.git_branch,
    dependencies: JSON.parse(row.dependencies || '{}'),
    indexedAt: row.indexed_at,
  }));
}

/**
 * Index all registered projects.
 */
export function indexAllProjects(): void {
  const projects = loadProjects();
  for (const project of projects) {
    indexProject(project);
    console.log(`  ✓ Indexed project: ${project.name}`);
  }
}
