/**
 * Slack file/attachment processing — downloads files from Slack and converts
 * them to pi-ai content blocks for multimodal Claude input.
 *
 * Supported:
 *   - Images (png, jpg, gif, webp) → ImageContent (base64)
 *   - Text files (txt, md, ts, js, py, json, csv, etc.) → TextContent
 *   - PDFs → TextContent with note (text extraction only)
 *
 * Unsupported binary files are noted but skipped.
 */

import type { TextContent, ImageContent } from '@mariozechner/pi-ai';

export type ContentBlock = TextContent | ImageContent;

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
}

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h', 'hpp',
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'csv', 'tsv', 'xml', 'html', 'css', 'scss', 'less',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'graphql', 'gql', 'prisma',
  'dockerfile', 'makefile', 'env', 'gitignore',
  'log', 'diff', 'patch',
]);

// Max file sizes
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB (Claude's limit)
const MAX_TEXT_BYTES = 1 * 1024 * 1024;   // 1MB for text files

/**
 * Download Slack files and convert to pi-ai content blocks.
 * Returns an array of content blocks ready to include in a UserMessage.
 */
export async function processSlackFiles(
  files: SlackFile[],
  botToken: string,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  for (const file of files) {
    try {
      const block = await processFile(file, botToken);
      if (block) {
        blocks.push(block);
      }
    } catch (err: any) {
      // Don't fail the whole message if one file can't be processed
      blocks.push({
        type: 'text',
        text: `[Attachment: ${file.name} — failed to process: ${err.message}]`,
      });
    }
  }

  return blocks;
}

async function processFile(
  file: SlackFile,
  botToken: string,
): Promise<ContentBlock | null> {
  const url = file.url_private_download || file.url_private;
  if (!url) {
    return { type: 'text', text: `[Attachment: ${file.name} — no download URL]` };
  }

  // Images
  if (IMAGE_MIMES.has(file.mimetype)) {
    if (file.size > MAX_IMAGE_BYTES) {
      return { type: 'text', text: `[Image: ${file.name} — too large (${formatSize(file.size)}, max 20MB)]` };
    }
    const buffer = await downloadFile(url, botToken);
    return {
      type: 'image',
      data: buffer.toString('base64'),
      mimeType: file.mimetype,
    };
  }

  // Text files
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const isText = TEXT_EXTENSIONS.has(ext)
    || file.mimetype.startsWith('text/')
    || file.mimetype === 'application/json'
    || file.mimetype === 'application/xml'
    || file.filetype === 'text';

  if (isText) {
    if (file.size > MAX_TEXT_BYTES) {
      return { type: 'text', text: `[File: ${file.name} — too large (${formatSize(file.size)}, max 1MB)]` };
    }
    const buffer = await downloadFile(url, botToken);
    const content = buffer.toString('utf-8');
    return {
      type: 'text',
      text: `[File: ${file.name}]\n\`\`\`\n${content}\n\`\`\``,
    };
  }

  // PDF — include as note, no text extraction for now
  if (file.mimetype === 'application/pdf') {
    return { type: 'text', text: `[PDF attached: ${file.name} (${formatSize(file.size)}) — PDF text extraction not yet supported]` };
  }

  // Unsupported binary
  return {
    type: 'text',
    text: `[Attachment: ${file.name} (${file.mimetype}, ${formatSize(file.size)}) — binary file type not supported]`,
  };
}

async function downloadFile(url: string, botToken: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
