/**
 * get_project_context tool — returns project structure, git history,
 * dependencies, and key files for registered projects.
 */

import type { Tool, ToolInput, ToolResult } from './types.js';
import {
  getProjectSummary,
  type ProjectSummary,
} from '../workspace/indexer.js';
import { loadProjects } from '../workspace/registry.js';

function formatSummary(summary: ProjectSummary, include: Set<string>): string {
  const sections: string[] = [];

  // Find project description from registry
  const projects = loadProjects();
  const project = projects.find((p) => p.name === summary.projectName);
  sections.push(`Project: ${summary.projectName}`);
  if (project) {
    sections.push(`Description: ${project.description}`);
    sections.push(`Language: ${project.language}`);
    sections.push(`Path: ${project.path}`);
  }
  sections.push(`Last indexed: ${summary.indexedAt}`);

  if (include.has('git')) {
    sections.push(`\n--- Git (${summary.gitBranch}) ---`);
    sections.push(summary.gitLog || '(no git history)');
  }

  if (include.has('tree')) {
    sections.push('\n--- File Tree ---');
    sections.push(summary.treeText || '(empty)');
  }

  if (include.has('dependencies')) {
    const deps = summary.dependencies;
    const depList = Object.entries(deps);
    if (depList.length > 0) {
      sections.push('\n--- Dependencies ---');
      for (const [name, version] of depList) {
        sections.push(`  ${name}: ${version}`);
      }
    }
  }

  if (include.has('key_files')) {
    const files = summary.keyFiles;
    const fileNames = Object.keys(files);
    if (fileNames.length > 0) {
      sections.push('\n--- Key Files ---');
      for (const name of fileNames) {
        sections.push(`\n[${name}]`);
        sections.push(files[name]);
      }
    }
  }

  return sections.join('\n');
}

export const getProjectContextTool: Tool = {
  name: 'get_project_context',
  description:
    'Get context about a registered project — file tree, recent git changes, dependencies, ' +
    'and key files. Use before spawning sub-agents for coding tasks to provide them with ' +
    'project context. Call without a project name to list all registered projects.',
  input_schema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'Project name to get context for. Omit to list all projects.',
      },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['tree', 'git', 'dependencies', 'key_files'] },
        description: 'Which sections to include (default: all). Options: tree, git, dependencies, key_files',
      },
    },
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const projectName = input.project as string | undefined;

    // List all projects if no name given
    if (!projectName) {
      const projects = loadProjects();
      if (projects.length === 0) {
        return { success: true, output: 'No projects registered. Add them to config/projects.json.' };
      }

      const lines = projects.map(
        (p) => `- **${p.name}** (${p.language}): ${p.description}\n  Path: ${p.path}`,
      );
      return {
        success: true,
        output: `Registered projects:\n\n${lines.join('\n\n')}`,
      };
    }

    // Get specific project
    const summary = getProjectSummary(projectName);
    if (!summary) {
      return {
        success: false,
        error: `Project "${projectName}" not found. Use get_project_context without arguments to list available projects.`,
      };
    }

    const includeArr = (input.include as string[] | undefined) || [
      'tree',
      'git',
      'dependencies',
      'key_files',
    ];
    const includeSet = new Set(includeArr);

    return {
      success: true,
      output: formatSummary(summary, includeSet),
    };
  },
};
