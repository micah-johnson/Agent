import type { App, GenericMessageEvent } from '@slack/bolt';
import { ClaudeClient } from '../llm/client.js';
import { Orchestrator } from '../orchestrator/index.js';
import { ProgressUpdater } from './progress.js';
import { processMessage, log } from './process-message.js';
import { isUserAllowed, getMessageMode } from '../config/settings.js';
import { processSlackFiles, type ContentBlock } from './attachments.js';
export { processMessage, log, type ProcessMessageResult } from './process-message.js';

// Bot user ID — set at startup via auth.test(), used for @mention detection
let botUserId: string | null = null;
export function setBotUserId(id: string) { botUserId = id; }

// Dedup guard — Slack Socket Mode can deliver the same event twice
const processedMessages = new Set<string>();

const STOP_COMMANDS = new Set(['stop', '/stop', 'cancel', '/cancel']);

export function setupMessageHandler(app: App, claude: ClaudeClient, orchestrator: Orchestrator) {
  app.event('message', async ({ event, say, client }) => {
    const messageEvent = event as GenericMessageEvent;

    // Ignore bot messages, message edits, and non-file subtypes
    // Allow 'file_share' through so we can process attachments
    if (messageEvent.bot_id) return;
    if (messageEvent.subtype && messageEvent.subtype !== 'file_share') return;

    // Only respond to DMs (1:1 and group) with a real user
    if (!messageEvent.user) return;
    const isDirectDM = messageEvent.channel_type === 'im';
    const isGroupDM = messageEvent.channel_type === 'mpim';
    if (!isDirectDM && !isGroupDM) return;

    // In group DMs, only respond when @mentioned
    if (isGroupDM) {
      const text = messageEvent.text || '';
      if (!botUserId || !text.includes(`<@${botUserId}>`)) return;
    }

    // Auth check — ignore messages from non-allowed users
    if (!isUserAllowed(messageEvent.user)) {
      log(`Blocked message from unauthorized user: ${messageEvent.user}`);
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
    // Strip bot @mention from message text so the model sees clean input
    let userMessage = (messageEvent.text || '').trim();
    if (botUserId) {
      userMessage = userMessage.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
    }
    const slackFiles = (messageEvent as any).files as any[] | undefined;

    log(`Received: "${userMessage}" from ${userId}${slackFiles?.length ? ` (${slackFiles.length} file(s))` : ''}`);

    // Handle stop command — abort active work immediately (outside the lock)
    if (STOP_COMMANDS.has(userMessage.toLowerCase())) {
      const aborted = await orchestrator.abortChannel(channelId);
      log(`Stop command on ${channelId}: ${aborted ? 'aborted' : 'nothing running'}`);
      return;
    }

    // Mode-based routing when channel is active
    const mode = getMessageMode();

    if (orchestrator.isChannelActive(channelId)) {
      switch (mode) {
        case 'steer': {
          // Process attachments first if needed
          let attachments: ContentBlock[] | undefined;
          if (slackFiles?.length) {
            const botToken = process.env.SLACK_BOT_TOKEN!;
            attachments = await processSlackFiles(slackFiles, botToken);
          }
          orchestrator.steerChannel(channelId, userMessage, attachments);
          log(`Steered channel ${channelId}: "${userMessage}"`);
          return;
        }
        case 'interrupt': {
          await orchestrator.abortChannel(channelId);
          log(`Interrupted channel ${channelId}, processing new message`);
          // Fall through to withChannelLock below
          break;
        }
        case 'queue':
        default:
          // Fall through to withChannelLock (existing queue behavior)
          break;
      }
    }

    await orchestrator.withChannelLock(channelId, async () => {
      const t0 = Date.now();
      const signal = orchestrator.createAbortSignal(channelId);
      const progressRef = { current: new ProgressUpdater(channelId, client) };
      orchestrator.setActiveProgress(channelId, progressRef.current);

      try {
        progressRef.current.postInitial(); // Non-blocking — Slack API call runs in parallel with Claude
        log(`postInitial fired (non-blocking) at ${Date.now() - t0}ms`);

        // Process file attachments (download + convert to content blocks)
        let attachments: ContentBlock[] | undefined;
        if (slackFiles?.length) {
          const botToken = process.env.SLACK_BOT_TOKEN!;
          attachments = await processSlackFiles(slackFiles, botToken);
          log(`Processed ${attachments.length} attachment(s) in ${Date.now() - t0}ms`);
        }

        // Build steer callbacks
        const steer = {
          consume: () => orchestrator.consumeSteer(channelId),
          registerCallAbort: (controller: AbortController) => orchestrator.registerCallAbort(channelId, controller),
          clearCallAbort: () => orchestrator.clearCallAbort(channelId),
          onSteer: (message: string) => {
            log(`Steer injected: "${message.substring(0, 80)}"`);
            // Delete old progress, create new one
            const oldProgress = progressRef.current;
            oldProgress.dismiss().catch(() => {});
            const newProgress = new ProgressUpdater(channelId, client);
            newProgress.postInitial();
            progressRef.current = newProgress;
            orchestrator.setActiveProgress(channelId, newProgress);
          },
        };

        const result = await processMessage(
          channelId,
          userId,
          userMessage,
          client,
          claude,
          orchestrator,
          (event) => progressRef.current.onProgress(event),
          (ts, blocks) => progressRef.current.adoptMessage(ts, blocks),
          signal,
          attachments,
          () => progressRef.current.getMessageTs(),
          steer,
          (text) => progressRef.current.showIntermediateText(text),
        );

        // If aborted, abortChannel() already updated the message
        if (!signal.aborted) {
          await progressRef.current.finalize(result.text, result.toolCalls, result.usage);
        }
      } catch (error: any) {
        if (!signal.aborted) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const errStack = error instanceof Error ? error.stack : 'no stack';
          log(`ERROR processing "${userMessage}": ${errMsg}`);
          log(`STACK: ${errStack}`);
          await progressRef.current.abort('Sorry, something went wrong processing your message.');
        }
      } finally {
        orchestrator.clearAbortSignal(channelId);
      }
    });
  });

  console.log('✓ Message handler registered');
}
