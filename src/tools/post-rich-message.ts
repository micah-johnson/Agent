/**
 * post_rich_message tool — posts Block Kit messages to Slack
 *
 * Factory pattern: createPostRichMessageTool(client, context) returns a Tool
 * with Slack WebClient and channel context injected via closure.
 */

import type { WebClient } from '@slack/web-api';
import type { Tool, ToolInput, ToolResult } from './types.js';

export interface RichMessageContext {
  channel_id: string;
  onNewMessage?: (ts: string, blocks: any[]) => void;
}

export function createPostRichMessageTool(
  slackClient: WebClient,
  context: RichMessageContext,
): Tool {
  return {
    name: 'post_rich_message',
    description:
      'Post a rich Slack message using Block Kit for structured content. ' +
      'Use this for: status updates, project summaries, task lists, confirmation prompts with buttons, ' +
      'multi-choice questions with dropdowns, tables, data comparisons. Do NOT use for simple conversational replies — ' +
      'use your normal text response for those. Returns the message timestamp for future updates.',
    input_schema: {
      type: 'object',
      properties: {
        blocks: {
          type: 'array',
          description:
            'Slack Block Kit blocks array. Each block is an object with a "type" field. ' +
            'Common types: "header", "section", "divider", "actions", "context", "image". ' +
            'Text objects use {type: "mrkdwn", text: "..."} or {type: "plain_text", text: "..."}. ' +
            'Interactive elements (buttons, selects) go in "actions" blocks.',
        },
        text: {
          type: 'string',
          description:
            'Fallback text shown in notifications and accessibility contexts. Required.',
        },
        replace_ts: {
          type: 'string',
          description:
            'Optional: timestamp of a specific existing message to update.',
        },
      },
      required: ['blocks', 'text'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      const blocks = input.blocks as any[];
      const text = input.text as string;
      const replaceTs = input.replace_ts as string | undefined;

      // Validate
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return { success: false, error: 'blocks must be a non-empty array' };
      }
      if (blocks.length > 50) {
        return { success: false, error: 'Maximum 50 blocks per message' };
      }
      if (!text || typeof text !== 'string') {
        return { success: false, error: 'text is required as fallback' };
      }

      try {
        if (replaceTs) {
          // Update a specific existing message
          const result = await slackClient.chat.update({
            channel: context.channel_id,
            ts: replaceTs,
            blocks,
            text,
          });
          return {
            success: true,
            output: `Rich message updated (ts: ${result.ts})`,
            metadata: { ts: result.ts },
          };
        } else {
          // Post new message, notify progress updater to adopt it
          const result = await slackClient.chat.postMessage({
            channel: context.channel_id,
            blocks,
            text,
          });
          context.onNewMessage?.(result.ts!, blocks);
          return {
            success: true,
            output: `Rich message posted (ts: ${result.ts}). Save this ts value if you need to update the message later.`,
            metadata: { ts: result.ts },
          };
        }
      } catch (err: any) {
        return {
          success: false,
          error: `Slack API error: ${err?.message || err}`,
        };
      }
    },
  };
}
