/**
 * Token estimation utility — shared across agent loop and pre-call compaction.
 *
 * Uses a rough character-based approximation: ~4 chars per token for English text.
 */

import type { Message, AssistantMessage, ToolCall } from '@mariozechner/pi-ai';

/** Rough token estimate — ~4 chars per token for English text. */
export function estimateMessageTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block) chars += block.text.length;
        }
      }
    } else if (msg.role === 'assistant') {
      for (const block of (msg as AssistantMessage).content) {
        if ('text' in block) chars += (block as any).text.length;
        if ('thinking' in block) chars += (block as any).thinking.length;
        if (block.type === 'toolCall') chars += JSON.stringify((block as ToolCall).arguments).length + 100;
      }
    } else if (msg.role === 'toolResult') {
      const tr = msg as any;
      if (tr.content) {
        for (const block of tr.content) {
          if (block.type === 'text') chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
