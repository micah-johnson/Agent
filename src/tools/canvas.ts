/**
 * Canvas tool — create and edit Slack Canvases
 *
 * Like Anthropic's Artifacts but native to Slack. Use for plans, reports,
 * analyses, documentation — anything that's better as a document than a chat message.
 *
 * Factory pattern: createCanvasTool(client, context) returns a Tool
 * with Slack WebClient and channel context injected via closure.
 */

import type { WebClient } from '@slack/web-api';
import type { Tool, ToolInput, ToolResult } from './types.js';

export interface CanvasContext {
  channel_id: string;
  user_id: string;
}

export function createCanvasTool(
  slackClient: WebClient,
  context: CanvasContext,
): Tool {
  return {
    name: 'canvas',
    description:
      'Create or edit Slack Canvases — rich, persistent documents that live in Slack. ' +
      'Use canvases for plans, reports, analyses, documentation, checklists, or any long-form content ' +
      'that would be unwieldy as a chat message. Canvases support full markdown: headings, tables, ' +
      'code blocks, checklists, bold/italic, links, @mentions, and images. ' +
      'After creating a canvas, share the link in chat so the user can open it.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'edit', 'delete', 'lookup_sections'],
          description:
            'Action to perform. "create" makes a new canvas. "edit" modifies an existing one. ' +
            '"delete" removes a canvas. "lookup_sections" finds section IDs for targeted edits.',
        },
        title: {
          type: 'string',
          description: 'Canvas title. Required for "create". For "edit", use operation "rename" to change it.',
        },
        markdown: {
          type: 'string',
          description:
            'Markdown content for the canvas. Used with "create" and "edit" actions. ' +
            'Supports: headings (# ## ###), **bold**, *italic*, ~~strikethrough~~, `code`, ' +
            '```code blocks```, tables (| col | col |), checklists (- [ ] / - [x]), ' +
            'ordered/unordered lists, > blockquotes, --- dividers, [links](url), ' +
            'and @mentions via ![](@USER_ID) or ![](#CHANNEL_ID).',
        },
        canvas_id: {
          type: 'string',
          description: 'Canvas ID (starts with "F"). Required for "edit", "delete", and "lookup_sections".',
        },
        operation: {
          type: 'string',
          enum: ['insert_at_start', 'insert_at_end', 'insert_before', 'insert_after', 'replace', 'delete', 'rename'],
          description:
            'Edit operation. Required for "edit" action. ' +
            '"replace" without section_id replaces the entire canvas content. ' +
            '"rename" changes the title (use title param). ' +
            '"insert_at_start"/"insert_at_end" add content. ' +
            '"insert_before"/"insert_after"/"delete" require section_id.',
        },
        section_id: {
          type: 'string',
          description: 'Section ID for targeted edits. Get IDs via "lookup_sections" action.',
        },
        channel_id: {
          type: 'string',
          description: 'Channel to auto-attach the canvas to (adds it as a channel tab). Optional, only for "create".',
        },
        share_in_chat: {
          type: 'boolean',
          description: 'If true, posts a message in the current conversation with a link to the canvas after creating it. Default: true.',
        },
        access: {
          type: 'object',
          description: 'Set access after creating. Object with optional "channel_ids" (string[]) or "user_ids" (string[]) and "access_level" ("read" or "write").',
          properties: {
            channel_ids: { type: 'array', items: { type: 'string' } },
            user_ids: { type: 'array', items: { type: 'string' } },
            access_level: { type: 'string', enum: ['read', 'write'] },
          },
        },
      },
      required: ['action'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      const action = input.action as string;

      try {
        switch (action) {
          case 'create':
            return await handleCreate(slackClient, context, input);
          case 'edit':
            return await handleEdit(slackClient, input);
          case 'delete':
            return await handleDelete(slackClient, input);
          case 'lookup_sections':
            return await handleLookupSections(slackClient, input);
          default:
            return { success: false, error: `Unknown action: ${action}` };
        }
      } catch (err: any) {
        return {
          success: false,
          error: `Canvas API error: ${err?.data?.error || err?.message || err}`,
        };
      }
    },
  };
}

async function handleCreate(
  client: WebClient,
  context: CanvasContext,
  input: ToolInput,
): Promise<ToolResult> {
  const title = input.title as string | undefined;
  const markdown = input.markdown as string | undefined;
  const channelId = input.channel_id as string | undefined;
  const shareInChat = input.share_in_chat !== false; // default true
  const access = input.access as { channel_ids?: string[]; user_ids?: string[]; access_level?: string } | undefined;

  const params: Record<string, any> = {};
  if (title) params.title = title;
  if (markdown) {
    params.document_content = {
      type: 'markdown',
      markdown,
    };
  }
  if (channelId) params.channel_id = channelId;

  const result = await client.apiCall('canvases.create', params) as any;

  if (!result.ok) {
    return { success: false, error: `Failed to create canvas: ${result.error}` };
  }

  const canvasId = result.canvas_id;

  // Auto-grant the requesting user write access
  try {
    await client.apiCall('canvases.access.set', {
      canvas_id: canvasId,
      access_level: 'write',
      user_ids: [context.user_id],
    });
  } catch {
    // Non-fatal — user might already have access via channel
  }

  // Set additional access if requested
  if (access && (access.channel_ids?.length || access.user_ids?.length)) {
    try {
      const accessParams: Record<string, any> = {
        canvas_id: canvasId,
        access_level: access.access_level || 'read',
      };
      if (access.channel_ids?.length) accessParams.channel_ids = access.channel_ids;
      if (access.user_ids?.length) accessParams.user_ids = access.user_ids;

      await client.apiCall('canvases.access.set', accessParams);
    } catch (err: any) {
      // Non-fatal — canvas was created, just access setting failed
      return {
        success: true,
        output: `Canvas created (ID: ${canvasId}) but failed to set access: ${err?.message || err}`,
        metadata: { canvas_id: canvasId },
      };
    }
  }

  // Share link in chat
  if (shareInChat) {
    try {
      // Get the workspace URL to build the canvas link
      const authResult = await client.auth.test() as any;
      const teamUrl = authResult.url?.replace(/\/$/, ''); // e.g. https://team.slack.com

      // Canvas links follow the pattern: https://team.slack.com/docs/{team_id}/{canvas_id}
      const teamId = authResult.team_id;
      const canvasUrl = teamUrl && teamId ? `${teamUrl}/docs/${teamId}/${canvasId}` : undefined;
      const linkText = canvasUrl
        ? `📄 *${title || 'Canvas'}*\n<${canvasUrl}|Open Canvas>`
        : `📄 Canvas created: \`${canvasId}\``;

      await client.chat.postMessage({
        channel: context.channel_id,
        text: linkText,
      });
    } catch {
      // Non-fatal
    }
  }

  return {
    success: true,
    output: `Canvas created successfully.\nID: ${canvasId}\nTitle: ${title || '(untitled)'}`,
    metadata: { canvas_id: canvasId },
  };
}

async function handleEdit(
  client: WebClient,
  input: ToolInput,
): Promise<ToolResult> {
  const canvasId = input.canvas_id as string;
  const operation = input.operation as string;
  const markdown = input.markdown as string | undefined;
  const sectionId = input.section_id as string | undefined;

  if (!canvasId) {
    return { success: false, error: 'canvas_id is required for edit' };
  }
  if (!operation) {
    return { success: false, error: 'operation is required for edit' };
  }

  // Build the changes array
  const change: Record<string, any> = { operation };

  if (operation === 'rename') {
    // Rename uses title_content instead of document_content
    const title = input.title as string;
    if (!title) {
      return { success: false, error: 'title is required for rename operation' };
    }
    change.title_content = { type: 'markdown', markdown: title };
  } else if (operation === 'delete') {
    if (!sectionId) {
      return { success: false, error: 'section_id is required for delete operation' };
    }
    change.section_id = sectionId;
  } else {
    // All other operations use document_content
    if (!markdown) {
      return { success: false, error: 'markdown is required for this operation' };
    }
    change.document_content = { type: 'markdown', markdown };

    if (sectionId) {
      change.section_id = sectionId;
    }

    // Validate section_id requirements
    if (['insert_before', 'insert_after'].includes(operation) && !sectionId) {
      return { success: false, error: `section_id is required for ${operation}` };
    }
  }

  const result = await client.apiCall('canvases.edit', {
    canvas_id: canvasId,
    changes: [change],
  }) as any;

  if (!result.ok) {
    return { success: false, error: `Failed to edit canvas: ${result.error}` };
  }

  return {
    success: true,
    output: `Canvas ${canvasId} updated (operation: ${operation})`,
    metadata: { canvas_id: canvasId },
  };
}

async function handleDelete(
  client: WebClient,
  input: ToolInput,
): Promise<ToolResult> {
  const canvasId = input.canvas_id as string;
  if (!canvasId) {
    return { success: false, error: 'canvas_id is required for delete' };
  }

  const result = await client.apiCall('canvases.delete', {
    canvas_id: canvasId,
  }) as any;

  if (!result.ok) {
    return { success: false, error: `Failed to delete canvas: ${result.error}` };
  }

  return {
    success: true,
    output: `Canvas ${canvasId} deleted`,
  };
}

async function handleLookupSections(
  client: WebClient,
  input: ToolInput,
): Promise<ToolResult> {
  const canvasId = input.canvas_id as string;
  if (!canvasId) {
    return { success: false, error: 'canvas_id is required for lookup_sections' };
  }

  // Criteria is optional — returns all sections if not provided
  const criteria = input.criteria as { section_types?: string[]; contains_text?: string } | undefined;

  const params: Record<string, any> = { canvas_id: canvasId };
  if (criteria) params.criteria = criteria;

  const result = await client.apiCall('canvases.sections.lookup', params) as any;

  if (!result.ok) {
    return { success: false, error: `Failed to lookup sections: ${result.error}` };
  }

  const sections = result.sections || [];
  if (sections.length === 0) {
    return { success: true, output: 'No sections found matching criteria.' };
  }

  const sectionList = sections.map((s: any, i: number) =>
    `${i + 1}. ID: ${s.id} | Type: ${s.type || 'unknown'}`
  ).join('\n');

  return {
    success: true,
    output: `Found ${sections.length} section(s):\n${sectionList}`,
    metadata: { sections },
  };
}
