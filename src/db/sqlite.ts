/**
 * SQLite database singleton using bun:sqlite
 * WAL mode for concurrent reads from sub-agents
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DB_DIR = join(import.meta.dir, '../../data');
const DB_PATH = join(DB_DIR, 'cletus.sqlite');

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
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

  console.log('✓ SQLite database initialized');
  return db;
}
