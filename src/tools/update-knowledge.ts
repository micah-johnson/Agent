/**
 * update_knowledge tool — add or update entries in the
 * persistent knowledge base.
 *
 * Factory pattern: createUpdateKnowledgeTool(context) returns a Tool
 * bound to a specific user so writes target the correct file.
 *
 * Files:
 *   data/knowledge/_shared.md  — project/team knowledge (all users)
 *   data/knowledge/{userId}.md — personal preferences & decisions
 */

import type { Tool, ToolInput, ToolResult } from './types.js';
import { appendKnowledge, replaceKnowledgeSection } from '../memory/knowledge.js';

export function createUpdateKnowledgeTool(context: {
  user_id: string;
}): Tool {
  return {
    name: 'update_knowledge',
    description:
      'Add or update entries in the persistent knowledge base. Use this to record user ' +
      'preferences, project info, important decisions, and behavioral patterns that should ' +
      'be remembered across conversations. The knowledge base is loaded into every prompt.\n\n' +
      'Scope controls where data is stored:\n' +
      '- "personal" (default) — saved to the current user\'s personal file\n' +
      '- "shared" — saved to the shared knowledge file visible to all users',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Block to update. Options:\n' +
            '- "Preferences" — user preferences and working style\n' +
            '- "Patterns" — behavioral patterns\n' +
            '- "persona" — agent personality rules (shared only)\n' +
            '- "project:{name}" — project-specific knowledge (e.g., "project:data-engine")\n' +
            '- Legacy: "Projects", "Decisions" still work for backward compatibility',
        },
        entry: {
          type: 'string',
          description: 'The content to add or the new section content (for replace)',
        },
        action: {
          type: 'string',
          description:
            'append (default) adds a bullet point, replace_section replaces the entire section',
          enum: ['append', 'replace_section'],
        },
        scope: {
          type: 'string',
          description:
            'Where to store: "personal" (default) for user-specific, "shared" for team-wide',
          enum: ['shared', 'personal'],
        },
      },
      required: ['section', 'entry'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      const section = input.section as string;
      const entry = input.entry as string;
      const action = (input.action as string) || 'append';
      const scope = (input.scope as 'shared' | 'personal') || 'personal';

      if (!section || !entry) {
        return { success: false, error: 'Both section and entry are required' };
      }

      const opts = { userId: context.user_id, scope };

      try {
        if (action === 'replace_section') {
          replaceKnowledgeSection(section, entry, opts);
          return {
            success: true,
            output: `Replaced section "${section}" in ${scope} knowledge base.`,
          };
        } else {
          appendKnowledge(section, entry, opts);
          return {
            success: true,
            output: `Added to "${section}" in ${scope} knowledge base: ${entry}`,
          };
        }
      } catch (err: any) {
        return { success: false, error: `Failed to update knowledge: ${err?.message || err}` };
      }
    },
  };
}
