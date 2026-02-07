/**
 * SQLite database singleton using bun:sqlite
 * WAL mode for concurrent reads from sub-agents
 */

import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DB_DIR = join(import.meta.dir, '../../data');
const DB_PATH = join(DB_DIR, 'agent.sqlite');

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Load sqlite-vec extension for vector search
  sqliteVec.load(db);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      prompt TEXT,
      model TEXT DEFAULT 'claude-sonnet-4-5',
      status TEXT DEFAULT 'pending',
      result TEXT,
      error TEXT,
      channel_id TEXT,
      user_id TEXT,
      iterations INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      channel_id TEXT PRIMARY KEY,
      messages TEXT DEFAULT '[]',
      summary TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Individual memory entries for search
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // FTS5 keyword search over memory entries
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      source UNINDEXED,
      source_id UNINDEXED,
      role UNINDEXED,
      created_at UNINDEXED
    )
  `);

  // Vector embeddings via sqlite-vec (voyage-3-lite: 512 dims)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
      entry_id INTEGER PRIMARY KEY,
      embedding float[512]
    )
  `);

  // Project workspace summaries
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_summaries (
      project_name TEXT PRIMARY KEY,
      tree_text TEXT,
      key_files TEXT,
      git_log TEXT,
      git_branch TEXT,
      dependencies TEXT,
      indexed_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Periodic WAL checkpoint to prevent unbounded WAL growth
  setInterval(() => {
    try {
      db?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err: any) {
      console.error(`[db] WAL checkpoint failed: ${err?.message || err}`);
    }
  }, 5 * 60 * 1000);

  console.log('✓ SQLite database initialized (with sqlite-vec)');
  return db;
}
