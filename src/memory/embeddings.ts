/**
 * Voyage AI embedding client
 *
 * Uses voyage-3-lite (1024 dims) for fast, cheap embeddings.
 * Supports batch embedding for documents and single-query embedding
 * with inputType differentiation for better retrieval quality.
 */

import { VoyageAIClient } from 'voyageai';

const EMBEDDING_MODEL = 'voyage-3-lite';
const MAX_BATCH_SIZE = 128; // Voyage API limit

let client: VoyageAIClient | null = null;

function getClient(): VoyageAIClient {
  if (client) return client;
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY not set in environment');
  }
  client = new VoyageAIClient({ apiKey });
  return client;
}

/**
 * Batch embed document texts. Returns one 1024-dim vector per input.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const voyage = getClient();
  const results: number[][] = [];

  // Process in batches of MAX_BATCH_SIZE
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const response = await voyage.embed({
      input: batch,
      model: EMBEDDING_MODEL,
      inputType: 'document',
    });

    for (const item of response.data ?? []) {
      results.push(item.embedding ?? []);
    }
  }

  return results;
}

/**
 * Embed a single search query. Uses inputType: 'query' for
 * better retrieval performance (asymmetric embedding).
 */
export async function embedQuery(query: string): Promise<number[]> {
  const voyage = getClient();
  const response = await voyage.embed({
    input: query,
    model: EMBEDDING_MODEL,
    inputType: 'query',
  });

  const first = response.data?.[0];
  if (!first?.embedding) {
    throw new Error('No embedding returned from Voyage AI');
  }
  return first.embedding;
}
