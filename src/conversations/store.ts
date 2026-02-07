/**
 * Conversation store — persists per-channel message history to SQLite
 *
 * Messages are stored as a JSON blob per channel. Simple and preserves
 * the exact pi-ai Message types without serialization issues.
 */

import { getDb } from '../db/sqlite.js';
import type { Message } from '@mariozechner/pi-ai';

/**
 * Strip orphaned toolResult messages from the start of history.
 * This can happen when save() trims between a tool_use and its tool_result,
 * or after compaction drops context. The API rejects orphaned tool_results.
 */
function sanitizeHistory(messages: Message[]): Message[] {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const assistant = msg as any;
      if (Array.isArray(assistant.content)) {
        for (const block of assistant.content) {
          if (block.type === 'toolCall' && block.id) {
            toolUseIds.add(block.id);
          }
        }
      }
    }
  }

  // Drop any toolResult that references a non-existent tool_use
  return messages.filter((msg) => {
    if (msg.role === 'toolResult') {
      const result = msg as any;
      return toolUseIds.has(result.toolCallId);
    }
    return true;
  });
}

export class ConversationStore {
  load(channelId: string): Message[] {
    const db = getDb();
    const row = db.query('SELECT messages FROM conversations WHERE channel_id = ?').get(channelId) as
      | { messages: string }
      | null;

    if (!row) return [];

    try {
      const messages = JSON.parse(row.messages) as Message[];
      return sanitizeHistory(messages);
    } catch {
      return [];
    }
  }

  save(channelId: string, messages: Message[]): void {
    const db = getDb();
    const json = JSON.stringify(messages);

    db.run(
      `INSERT INTO conversations (channel_id, messages, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(channel_id) DO UPDATE SET
         messages = excluded.messages,
         updated_at = excluded.updated_at`,
      [channelId, json],
    );
  }

  saveSummary(channelId: string, summary: string, compactedMessages: Message[]): void {
    const db = getDb();
    const json = JSON.stringify(compactedMessages);

    db.run(
      `UPDATE conversations SET messages = ?, summary = ?, updated_at = datetime('now')
       WHERE channel_id = ?`,
      [json, summary, channelId],
    );
  }
}
