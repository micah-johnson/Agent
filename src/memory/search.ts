/**
 * Hybrid memory search — FTS5 keyword + sqlite-vec semantic
 *
 * Runs both searches, merges and deduplicates results,
 * returns a ranked list of memory entries.
 *
 * Memory is global — all users share the same search pool.
 * The user_id column exists on memory_entries for metadata/audit
 * but is not used for filtering.
 */

import { getDb } from '../db/sqlite.js';
import { embedQuery } from './embeddings.js';

export interface SearchResult {
  id: number;
  source: string;
  sourceId: string;
  role: string;
  content: string;
  createdAt: string;
  score: number;
  matchType: 'keyword' | 'semantic' | 'both';
}

export interface SearchOptions {
  limit?: number;
  source?: 'conversation' | 'task';
}

/**
 * Escape special FTS5 characters in a query string.
 * FTS5 query syntax uses " * ^ NEAR etc — we wrap each
 * token in double quotes to treat them as literals.
 */
function escapeFts5Query(query: string): string {
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * Search memory using both FTS5 and vector similarity.
 * Results are merged, deduplicated, and ranked.
 */
export async function searchMemory(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const fetchLimit = limit * 2; // fetch more from each source, then trim

  const db = getDb();
  const resultMap = new Map<number, SearchResult>();

  // --- FTS5 keyword search ---
  try {
    const escaped = escapeFts5Query(query);
    if (escaped.length > 0) {
      let ftsSql = `
        SELECT rowid, content, source, source_id, role, created_at, rank
        FROM memory_fts
        WHERE content MATCH ?
      `;
      const params: any[] = [escaped];

      if (options.source) {
        ftsSql += ' AND source = ?';
        params.push(options.source);
      }

      ftsSql += ' ORDER BY rank LIMIT ?';
      params.push(fetchLimit);

      const ftsRows = db.query(ftsSql).all(...params) as any[];

      for (const row of ftsRows) {
        // FTS5 rank is negative (more negative = better match)
        const normalizedScore = Math.abs(row.rank);
        resultMap.set(row.rowid, {
          id: row.rowid,
          source: row.source,
          sourceId: row.source_id,
          role: row.role,
          content: row.content,
          createdAt: row.created_at,
          score: normalizedScore,
          matchType: 'keyword',
        });
      }
    }
  } catch (err: any) {
    console.error(`[search] FTS5 search failed: ${err?.message || err}`);
  }

  // --- Vector semantic search ---
  try {
    const queryVec = await embedQuery(query);
    const vecBuffer = new Float32Array(queryVec);

    // sqlite-vec KNN queries require `k = ?` constraint, not LIMIT.
    // Do KNN first, then join to memory_entries for metadata.
    const knnRows = db
      .query(
        `SELECT entry_id, distance
         FROM memory_vec
         WHERE embedding MATCH ? AND k = ?`,
      )
      .all(vecBuffer, fetchLimit) as Array<{ entry_id: number; distance: number }>;

    // Join with metadata and apply source filter
    const vecRows: any[] = [];
    for (const knn of knnRows) {
      const entry = db
        .query('SELECT id, content, source, source_id, role, created_at FROM memory_entries WHERE id = ?')
        .get(knn.entry_id) as any;
      if (!entry) continue;
      if (options.source && entry.source !== options.source) continue;
      vecRows.push({ ...entry, entry_id: knn.entry_id, distance: knn.distance });
    }

    // Normalize vector distances to scores (lower distance = higher score)
    const maxDist = vecRows.length > 0 ? Math.max(...vecRows.map((r) => r.distance), 1) : 1;

    for (const row of vecRows) {
      const semanticScore = 1 - row.distance / maxDist;
      const existing = resultMap.get(row.entry_id);

      if (existing) {
        // Found in both FTS5 and vector — boost score
        existing.score += semanticScore;
        existing.matchType = 'both';
      } else {
        resultMap.set(row.entry_id, {
          id: row.entry_id,
          source: row.source,
          sourceId: row.source_id,
          role: row.role,
          content: row.content,
          createdAt: row.created_at,
          score: semanticScore,
          matchType: 'semantic',
        });
      }
    }
  } catch (err: any) {
    console.error(`[search] Vector search failed: ${err?.message || err}`);
  }

  // Sort by score descending and return top N
  return Array.from(resultMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
