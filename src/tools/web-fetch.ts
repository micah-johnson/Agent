/**
 * Web Fetch tool - fetch URLs and return their content
 * Handles HTML (strips tags), JSON (pretty-print), and plain text
 */

import type { Tool, ToolInput, ToolResult } from './types.js';

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_LENGTH = 50000; // 50k chars
const USER_AGENT = 'Agent/1.0 (bot)';

/**
 * Strip HTML tags and clean up the content for readability
 */
function processHtml(html: string): string {
  // Extract title if present
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Remove script tags and their contents
  let cleaned = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  
  // Remove style tags and their contents
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  
  // Remove all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  
  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  
  // Collapse whitespace: multiple spaces → 1, multiple newlines → max 2
  cleaned = cleaned.replace(/ +/g, ' ');
  cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, '\n\n');
  
  // Trim lines
  cleaned = cleaned.split('\n').map(line => line.trim()).join('\n');
  
  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();
  
  // Prepend title if found
  if (title) {
    return `Title: ${title}\n\n${cleaned}`;
  }
  
  return cleaned;
}

/**
 * Detect content type from response headers
 */
function detectMode(contentType: string | null): 'html' | 'json' | 'text' {
  if (!contentType) return 'text';
  
  const type = contentType.toLowerCase();
  
  if (type.includes('text/html') || type.includes('application/xhtml')) {
    return 'html';
  } else if (type.includes('application/json') || type.includes('application/ld+json')) {
    return 'json';
  } else {
    return 'text';
  }
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch URLs and return their content. Handles HTML (strips tags for readability), JSON (pretty-print), and plain text.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      method: {
        type: 'string',
        description: 'HTTP method, default GET',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
      },
      headers: {
        type: 'object',
        description: 'Custom headers as key-value pairs',
      },
      body: {
        type: 'string',
        description: 'Request body for POST/PUT/PATCH',
      },
      mode: {
        type: 'string',
        description: 'How to process the response. Auto detects from content-type.',
        enum: ['auto', 'html', 'json', 'text', 'raw'],
      },
      max_length: {
        type: 'number',
        description: 'Max response length in chars, default 50000',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms, default 30000',
      },
    },
    required: ['url'],
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const url = input.url as string;
    const method = (input.method as string || 'GET').toUpperCase();
    const customHeaders = input.headers as Record<string, string> | undefined;
    const body = input.body as string | undefined;
    const mode = (input.mode as string || 'auto').toLowerCase();
    const maxLength = (input.max_length as number) || DEFAULT_MAX_LENGTH;
    const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

    // Validate URL
    if (!url || typeof url !== 'string') {
      return {
        success: false,
        error: 'URL is required and must be a string',
      };
    }

    try {
      new URL(url); // Validate URL format
    } catch {
      return {
        success: false,
        error: 'Invalid URL format',
      };
    }

    // Validate method
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
    if (!validMethods.includes(method)) {
      return {
        success: false,
        error: `Invalid method. Must be one of: ${validMethods.join(', ')}`,
      };
    }

    // Validate mode
    const validModes = ['auto', 'html', 'json', 'text', 'raw'];
    if (!validModes.includes(mode)) {
      return {
        success: false,
        error: `Invalid mode. Must be one of: ${validModes.join(', ')}`,
      };
    }

    // Build headers
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      ...customHeaders,
    };

    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type');
      const contentLength = response.headers.get('content-length');
      
      // Get response text
      let responseText: string;
      try {
        responseText = await response.text();
      } catch (error: any) {
        return {
          success: false,
          error: `Failed to read response body: ${error.message}`,
          metadata: {
            status: response.status,
            statusText: response.statusText,
            contentType,
          },
        };
      }

      // Determine processing mode
      let processingMode = mode;
      if (mode === 'auto') {
        processingMode = detectMode(contentType);
      }

      // Process response based on mode
      let processedContent = responseText;
      
      if (processingMode === 'html') {
        processedContent = processHtml(responseText);
      } else if (processingMode === 'json') {
        try {
          const parsed = JSON.parse(responseText);
          processedContent = JSON.stringify(parsed, null, 2);
        } catch {
          // If JSON parsing fails, fall back to raw text
          processedContent = responseText;
        }
      }
      // For 'text' and 'raw' modes, use responseText as-is

      // Truncate if needed
      if (processedContent.length > maxLength) {
        processedContent = processedContent.substring(0, maxLength) + '\n\n... (content truncated)';
      }

      // Build metadata
      const metadata: Record<string, any> = {
        status: response.status,
        statusText: response.statusText,
        contentType,
        contentLength: contentLength ? parseInt(contentLength, 10) : responseText.length,
        actualLength: responseText.length,
        processedLength: processedContent.length,
        mode: processingMode,
      };

      // For non-2xx responses, still return the content but mark as potentially unsuccessful
      const isSuccess = response.status >= 200 && response.status < 300;

      return {
        success: isSuccess,
        output: processedContent,
        error: isSuccess ? undefined : `HTTP ${response.status}: ${response.statusText}`,
        metadata,
      };

    } catch (error: any) {
      clearTimeout(timeoutId);

      // Handle timeout
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: `Request timed out after ${timeout}ms`,
        };
      }

      // Handle network errors
      return {
        success: false,
        error: `Network error: ${error.message}`,
      };
    }
  },
};
