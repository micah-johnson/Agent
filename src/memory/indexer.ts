/**
 * Memory indexer — writes conversation and task entries to
 * FTS5 (keyword search) and sqlite-vec (vector search).
 *
 * Called async after each conversation turn and task completion.
 */

import { getDb } from '../db/sqlite.js';
import { embed } from './embeddings.js';

const MIN_CONTENT_LENGTH = 50;
const MIN_EMBED_LENGTH = 100; // Only generate vectors for substantial content

// Skip patterns — messages matching these aren't worth indexing
const NOISE_PATTERNS = [
  /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|sure|yep|yes|no|nope|cool|nice|great|got it|sounds good|perfect|done|on it)\b/i,
  /^\[User clicked:/,  // Button interactions
  /^(testing|test|ignore this)/i,
];

export interface IndexEntry {
  role: string;
  content: string;
}

/**
 * Index one or more entries into memory_entries + memory_fts + memory_vec.
 * Skips entries that are too short or empty.
 */
export async function indexMessages(
  source: 'conversation' | 'task',
  sourceId: string,
  entries: IndexEntry[],
): Promise<void> {
  const valid = entries.filter((e) => {
    const content = e.content.trim();
    if (content.length < MIN_CONTENT_LENGTH) return false;
    if (NOISE_PATTERNS.some(pattern => pattern.test(content))) return false;
    return true;
  });
  if (valid.length === 0) return;

  const db = getDb();

  const insertEntry = db.prepare(
    `INSERT INTO memory_entries (source, source_id, role, content)
     VALUES (?, ?, ?, ?)`,
  );

  const insertFts = db.prepare(
    `INSERT INTO memory_fts (rowid, content, source, source_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  );

  const insertVec = db.prepare(
    `INSERT INTO memory_vec (entry_id, embedding)
     VALUES (?, ?)`,
  );

  // Insert entries into memory_entries and memory_fts (synchronous)
  const entryIds: number[] = [];
  for (const entry of valid) {
    const result = insertEntry.run(source, sourceId, entry.role, entry.content);
    const id = Number(result.lastInsertRowid);
    entryIds.push(id);

    insertFts.run(id, entry.content, source, sourceId, entry.role);
  }

  // Generate embeddings only for substantial content (save API credits)
  const embeddable = valid.filter(e => e.content.trim().length >= MIN_EMBED_LENGTH);
  if (embeddable.length > 0) {
    try {
      const texts = embeddable.map((e) => e.content);
      const embeddings = await embed(texts);

      // Map embeddable entries back to their IDs
      const embeddableIndices = valid
        .map((e, i) => ({ entry: e, id: entryIds[i] }))
        .filter(({ entry }) => entry.content.trim().length >= MIN_EMBED_LENGTH);

      for (let i = 0; i < embeddableIndices.length; i++) {
        const vec = new Float32Array(embeddings[i]);
        insertVec.run(embeddableIndices[i].id, vec);
      }
    } catch (err: any) {
      console.error(`[indexer] Vector embedding failed: ${err?.message || err}`);
    }
  }
}
