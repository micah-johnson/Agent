/**
 * search_memory tool — hybrid FTS5 + vector search over past
 * conversations and task results.
 *
 * Memory search is global — all users share the same pool.
 * This lets the agent leverage learnings from any conversation.
 */

import type { Tool, ToolInput, ToolResult } from './types.js';
import { searchMemory, type SearchResult } from '../memory/search.js';

function formatResult(r: SearchResult): string {
  const source = r.source === 'conversation' ? `conversation:${r.sourceId}` : `task:${r.sourceId}`;
  const match = r.matchType === 'both' ? 'keyword+semantic' : r.matchType;
  return `[${r.createdAt}] (${source}, ${r.role}, ${match})\n${r.content}`;
}

export const searchMemoryTool: Tool = {
  name: 'search_memory',
  description:
    'Search past conversations and task results. Use this to find previous discussions, ' +
    'decisions, file paths, preferences, or any historical context. Supports both keyword ' +
    'and semantic (meaning-based) search.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — keywords or a natural language description of what you\'re looking for',
      },
      source: {
        type: 'string',
        description: 'Filter by source type',
        enum: ['conversation', 'task'],
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default 10)',
      },
    },
    required: ['query'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const query = input.query as string;
    if (!query || query.trim().length === 0) {
      return { success: false, error: 'Query cannot be empty' };
    }

    try {
      const results = await searchMemory(query, {
        limit: (input.limit as number) || 10,
        source: input.source as 'conversation' | 'task' | undefined,
      });

      if (results.length === 0) {
        return { success: true, output: 'No memories found matching that query.' };
      }

      const output = results.map(formatResult).join('\n\n---\n\n');
      return {
        success: true,
        output: `Found ${results.length} result(s):\n\n${output}`,
      };
    } catch (err: any) {
      return { success: false, error: `Search failed: ${err?.message || err}` };
    }
  },
};
