/**
 * Memory indexer — writes conversation and task entries to
 * FTS5 (keyword search) and sqlite-vec (vector search).
 *
 * Called async after each conversation turn and task completion.
 */

import { getDb } from '../db/sqlite.js';
import { embed } from './embeddings.js';

const MIN_CONTENT_LENGTH = 10;

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
  const valid = entries.filter((e) => e.content.trim().length >= MIN_CONTENT_LENGTH);
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

  // Generate embeddings and insert into memory_vec (async)
  try {
    const texts = valid.map((e) => e.content);
    const embeddings = await embed(texts);

    for (let i = 0; i < entryIds.length; i++) {
      const vec = new Float32Array(embeddings[i]);
      insertVec.run(entryIds[i], vec);
    }
  } catch (err: any) {
    // Log but don't fail — FTS5 search still works without vectors
    console.error(`[indexer] Vector embedding failed: ${err?.message || err}`);
  }
}
