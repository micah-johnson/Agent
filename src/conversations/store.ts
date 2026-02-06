/**
 * Conversation store — persists per-channel message history to SQLite
 *
 * Messages are stored as a JSON blob per channel. Simple and preserves
 * the exact pi-ai Message types without serialization issues.
 */

import { getDb } from '../db/sqlite.js';
import type { Message } from '@mariozechner/pi-ai';

const MAX_MESSAGES = 50;

export class ConversationStore {
  load(channelId: string): Message[] {
    const db = getDb();
    const row = db.query('SELECT messages FROM conversations WHERE channel_id = ?').get(channelId) as
      | { messages: string }
      | null;

    if (!row) return [];

    try {
      return JSON.parse(row.messages) as Message[];
    } catch {
      return [];
    }
  }

  save(channelId: string, messages: Message[]): void {
    const db = getDb();
    const trimmed = messages.slice(-MAX_MESSAGES);
    const json = JSON.stringify(trimmed);

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
