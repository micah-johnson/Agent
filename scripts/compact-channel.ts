#!/usr/bin/env bun
/**
 * Emergency conversation compaction script.
 *
 * Compacts a stuck conversation that has exceeded the API token limit,
 * preserving context through LLM-powered summarization.
 *
 * Usage:
 *   bun scripts/compact-channel.ts <channel_id>
 *   bun scripts/compact-channel.ts --all          # compact all conversations over threshold
 */

import { Database } from 'bun:sqlite';
import { join } from 'path';
import { compactConversation } from '../src/conversations/compact.js';
import { estimateMessageTokens } from '../src/conversations/tokens.js';
import type { Message } from '@mariozechner/pi-ai';

const workspace = process.env.AGENT_WORKSPACE || join(import.meta.dir, '..');
const dbPath = join(workspace, 'data', 'agent.sqlite');

// Load API key from .env
const envPath = join(workspace, '.env');
const envFile = await Bun.file(envPath).text();
const apiKey = envFile.match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error('ERROR: ANTHROPIC_API_KEY not found in', envPath);
  process.exit(1);
}

const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

// 200k API limit minus ~90k for tool schemas/system prompt overhead
const PRE_CALL_TOKEN_LIMIT = 100_000;
const PRESERVE_TIERS = [5, 3, 1];

async function compactChannel(channelId: string): Promise<void> {
  const row = db.query('SELECT messages FROM conversations WHERE channel_id = ?').get(channelId) as
    | { messages: string }
    | null;

  if (!row) {
    console.log(`No conversation found for channel ${channelId}`);
    return;
  }

  let messages: Message[];
  try {
    messages = JSON.parse(row.messages);
  } catch {
    console.error(`Failed to parse messages for channel ${channelId}`);
    return;
  }

  let estimatedTokens = estimateMessageTokens(messages);
  console.log(`Channel ${channelId}: ${messages.length} messages, ~${estimatedTokens} tokens`);

  if (estimatedTokens <= PRE_CALL_TOKEN_LIMIT) {
    console.log(`  Already under ${PRE_CALL_TOKEN_LIMIT} token limit, skipping`);
    return;
  }

  for (const preserve of PRESERVE_TIERS) {
    if (estimatedTokens <= PRE_CALL_TOKEN_LIMIT) break;

    console.log(`  Compacting with ${preserve} preserved exchanges...`);
    try {
      const { messages: compacted, summary } = await compactConversation(messages, apiKey, preserve);
      const json = JSON.stringify(compacted);

      db.run(
        `UPDATE conversations SET messages = ?, summary = ?, updated_at = datetime('now') WHERE channel_id = ?`,
        [json, summary, channelId],
      );

      messages = compacted;
      estimatedTokens = estimateMessageTokens(messages);
      console.log(`  Done: ${messages.length} messages, ~${estimatedTokens} tokens`);
      console.log(`  Summary (${summary.length} chars):\n${summary.substring(0, 300)}...`);
    } catch (err: any) {
      console.error(`  Compaction failed (preserve=${preserve}): ${err?.message || err}`);
      break;
    }
  }

  if (estimatedTokens > PRE_CALL_TOKEN_LIMIT) {
    console.warn(`  WARNING: Still over limit after all compaction passes (~${estimatedTokens} tokens)`);
  } else {
    console.log(`  SUCCESS: Conversation compacted to ~${estimatedTokens} tokens`);
  }
}

// Parse args
const arg = process.argv[2];
if (!arg) {
  console.error('Usage: bun scripts/compact-channel.ts <channel_id|--all>');
  process.exit(1);
}

if (arg === '--all') {
  const rows = db.query('SELECT channel_id FROM conversations').all() as { channel_id: string }[];
  console.log(`Found ${rows.length} conversations\n`);
  for (const { channel_id } of rows) {
    await compactChannel(channel_id);
    console.log();
  }
} else {
  await compactChannel(arg);
}

db.close();
