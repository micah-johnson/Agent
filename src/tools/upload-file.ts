/**
 * upload_file tool — uploads files to Slack
 *
 * Factory pattern: createUploadFileTool(client, context) returns a Tool
 * with Slack WebClient and channel context injected via closure.
 */

import type { WebClient } from '@slack/web-api';
import type { Tool, ToolInput, ToolResult } from './types.js';
import { readFileSync, existsSync } from 'fs';

export interface UploadContext {
  channel_id: string;
}

export function createUploadFileTool(
  slackClient: WebClient,
  context: UploadContext,
): Tool {
  return {
    name: 'upload_file',
    description:
      'Upload a file to Slack. You can upload files from disk (provide file_path) or upload raw content (provide content string). ' +
      'Use this for: sharing generated files, reports, logs, code snippets as files, data exports (CSV/JSON), screenshots, or any file-based output. ' +
      'Filename is required and will be shown in Slack. Optionally provide a title, comment, and filetype hint for syntax highlighting.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'Absolute path to a file on disk to upload. Either file_path or content must be provided, but not both.',
        },
        content: {
          type: 'string',
          description:
            'Raw content to upload as a file (alternative to file_path). Either file_path or content must be provided, but not both.',
        },
        filename: {
          type: 'string',
          description:
            'Filename shown in Slack (e.g. "report.csv", "output.json", "script.py"). Required.',
        },
        title: {
          type: 'string',
          description:
            'Title shown above the file in Slack. Optional.',
        },
        comment: {
          type: 'string',
          description:
            'Message text shown alongside the file. Optional.',
        },
        filetype: {
          type: 'string',
          description:
            'File type hint for syntax highlighting (e.g. "csv", "json", "py", "txt", "javascript"). Optional.',
        },
      },
      required: ['filename'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      const filePath = input.file_path as string | undefined;
      const content = input.content as string | undefined;
      const filename = input.filename as string;
      const title = input.title as string | undefined;
      const comment = input.comment as string | undefined;
      const filetype = input.filetype as string | undefined;

      // Validate filename is provided
      if (!filename || typeof filename !== 'string') {
        return { success: false, error: 'filename is required' };
      }

      // Validate exactly one of file_path or content is provided
      if (!filePath && !content) {
        return {
          success: false,
          error: 'Either file_path or content must be provided',
        };
      }
      if (filePath && content) {
        return {
          success: false,
          error: 'Cannot provide both file_path and content — choose one',
        };
      }

      try {
        let fileBuffer: Buffer | undefined;
        let fileContent: string | undefined;

        if (filePath) {
          // Upload from disk
          if (!existsSync(filePath)) {
            return {
              success: false,
              error: `File not found: ${filePath}`,
            };
          }
          fileBuffer = readFileSync(filePath);
        } else {
          // Upload raw content
          fileContent = content;
        }

        // Build upload parameters
        const uploadParams: any = {
          channel_id: context.channel_id,
          filename: filename,
        };

        if (fileBuffer) {
          uploadParams.file = fileBuffer;
        } else {
          uploadParams.content = fileContent;
        }

        if (title) {
          uploadParams.title = title;
        }

        if (comment) {
          uploadParams.initial_comment = comment;
        }

        if (filetype) {
          uploadParams.filetype = filetype;
        }

        // Upload using Slack's filesUploadV2 API
        const result = await slackClient.filesUploadV2(uploadParams);

        if (!result.ok) {
          return {
            success: false,
            error: `Slack upload failed: ${result.error || 'unknown error'}`,
          };
        }

        // Extract file info from response
        const fileInfo = result.files?.[0]?.files?.[0];
        const fileId = fileInfo?.id;
        const permalink = fileInfo?.permalink;

        let output = `File uploaded successfully: ${filename}`;
        if (fileId) {
          output += ` (ID: ${fileId})`;
        }
        if (permalink) {
          output += `\nPermalink: ${permalink}`;
        }

        return {
          success: true,
          output: output,
          metadata: {
            file_id: fileId,
            permalink: permalink,
            filename: filename,
          },
        };
      } catch (err: any) {
        return {
          success: false,
          error: `Upload error: ${err?.message || err}`,
        };
      }
    },
  };
}
