/**
 * update_knowledge tool — add or update entries in the
 * persistent knowledge base (data/knowledge.md).
 */

import type { Tool, ToolInput, ToolResult } from './types.js';
import { appendKnowledge, replaceKnowledgeSection } from '../memory/knowledge.js';

export const updateKnowledgeTool: Tool = {
  name: 'update_knowledge',
  description:
    'Add or update entries in the persistent knowledge base. Use this to record user ' +
    'preferences, project info, important decisions, and behavioral patterns that should ' +
    'be remembered across conversations. The knowledge base is loaded into every prompt.',
  input_schema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        description: 'Section to update: Preferences, Projects, Decisions, or Patterns',
      },
      entry: {
        type: 'string',
        description: 'The content to add or the new section content (for replace)',
      },
      action: {
        type: 'string',
        description: 'append (default) adds a bullet point, replace_section replaces the entire section',
        enum: ['append', 'replace_section'],
      },
    },
    required: ['section', 'entry'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const section = input.section as string;
    const entry = input.entry as string;
    const action = (input.action as string) || 'append';

    if (!section || !entry) {
      return { success: false, error: 'Both section and entry are required' };
    }

    try {
      if (action === 'replace_section') {
        replaceKnowledgeSection(section, entry);
        return {
          success: true,
          output: `Replaced section "${section}" in knowledge base.`,
        };
      } else {
        appendKnowledge(section, entry);
        return {
          success: true,
          output: `Added to "${section}" in knowledge base: ${entry}`,
        };
      }
    } catch (err: any) {
      return { success: false, error: `Failed to update knowledge: ${err?.message || err}` };
    }
  },
};
