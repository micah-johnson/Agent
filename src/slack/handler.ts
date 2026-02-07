import { App, GenericMessageEvent } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { ClaudeClient } from '../llm/client.js';
import { Orchestrator } from '../orchestrator/index.js';
import { ProgressUpdater, type ProgressEvent } from './progress.js';
import { processMessage, log } from './process-message.js';
export { processMessage, log, type ProcessMessageResult } from './process-message.js';

// Auth: only respond to allowed Slack users
const allowedUsers = new Set(
  (process.env.ALLOWED_SLACK_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

// Dedup guard — Slack Socket Mode can deliver the same event twice
const processedMessages = new Set<string>();

const STOP_COMMANDS = new Set(['stop', '/stop', 'cancel', '/cancel']);

export function setupMessageHandler(app: App, claude: ClaudeClient, orchestrator: Orchestrator) {
  app.event('message', async ({ event, say, client }) => {
    const messageEvent = event as GenericMessageEvent;

    // Ignore bot messages, message edits, and other subtypes
    if (messageEvent.subtype || messageEvent.bot_id) {
      return;
    }

    // Only respond to DMs with a real user
    if (messageEvent.channel_type !== 'im' || !messageEvent.user) {
      return;
    }

    // Auth check — ignore messages from non-allowed users
    if (allowedUsers.size > 0 && !allowedUsers.has(messageEvent.user)) {
      return;
    }

    // Dedup — skip if we've already seen this exact message
    const dedupeKey = `${messageEvent.channel}:${messageEvent.ts}`;
    if (processedMessages.has(dedupeKey)) return;
    processedMessages.add(dedupeKey);
    // Keep set bounded — clear old entries periodically
    if (processedMessages.size > 200) {
      const entries = [...processedMessages];
      entries.slice(0, 100).forEach((k) => processedMessages.delete(k));
    }

    const channelId = messageEvent.channel;
    const userId = messageEvent.user;
    const userMessage = (messageEvent.text || '').trim();

    log(`Received: "${userMessage}" from ${userId}`);

    // Handle stop command — abort active work immediately (outside the lock)
    if (STOP_COMMANDS.has(userMessage.toLowerCase())) {
      const aborted = await orchestrator.abortChannel(channelId);
      log(`Stop command on ${channelId}: ${aborted ? 'aborted' : 'nothing running'}`);
      return;
    }

    await orchestrator.withChannelLock(channelId, async () => {
      const signal = orchestrator.createAbortSignal(channelId);
      const progress = new ProgressUpdater(channelId, client);
      orchestrator.setActiveProgress(channelId, progress);

      try {
        await progress.postInitial();

        const result = await processMessage(
          channelId,
          userId,
          userMessage,
          client,
          claude,
          orchestrator,
          (event) => progress.onProgress(event),
          (ts, blocks) => progress.adoptMessage(ts, blocks),
          signal,
        );

        // If aborted, abortChannel() already updated the message
        if (!signal.aborted) {
          await progress.finalize(result.text, result.toolCalls, result.usage);
        }
      } catch (error: any) {
        if (!signal.aborted) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const errStack = error instanceof Error ? error.stack : 'no stack';
          log(`ERROR processing "${userMessage}": ${errMsg}`);
          log(`STACK: ${errStack}`);
          await progress.abort('Sorry, something went wrong processing your message.');
        }
      } finally {
        orchestrator.clearAbortSignal(channelId);
      }
    });
  });

  console.log('✓ Message handler registered');
}
