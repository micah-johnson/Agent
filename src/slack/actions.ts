/**
 * Slack action handlers for Block Kit interactive elements.
 *
 * Handles button clicks and select menu interactions from
 * messages posted via post_rich_message. Injects the user's
 * choice back into the conversation and triggers an agent response.
 */

import type { App } from '@slack/bolt';
import type { ClaudeClient } from '../llm/client.js';
import type { Orchestrator } from '../orchestrator/index.js';
import { processMessage, log } from './process-message.js';
import { ProgressUpdater } from './progress.js';

export function setupActionHandlers(
  app: App,
  claude: ClaudeClient,
  orchestrator: Orchestrator,
): void {
  // Catch-all handler for any Block Kit action
  app.action(/.*/, async ({ action, body, ack, client }) => {
    await ack();

    const channelId =
      (body as any).channel?.id ||
      (body as any).container?.channel_id;
    const userId = body.user?.id;

    if (!channelId || !userId) return;

    // Auth check
    const allowed = (process.env.ALLOWED_SLACK_USERS || '').split(',').map((s) => s.trim());
    if (allowed.length > 0 && allowed[0] !== '' && !allowed.includes(userId)) return;

    // Extract what the user selected
    let actionText: string;
    if (action.type === 'button') {
      const label = (action as any).text?.text || (action as any).value || 'unknown';
      actionText = `[User clicked: ${label}]`;
    } else if (
      action.type === 'static_select' ||
      action.type === 'external_select' ||
      action.type === 'conversations_select' ||
      action.type === 'channels_select' ||
      action.type === 'users_select'
    ) {
      const selected =
        (action as any).selected_option?.text?.text ||
        (action as any).selected_option?.value ||
        (action as any).selected_user ||
        (action as any).selected_conversation ||
        (action as any).selected_channel ||
        'unknown';
      actionText = `[User selected: ${selected}]`;
    } else if (action.type === 'overflow') {
      const selected = (action as any).selected_option?.text?.text || 'unknown';
      actionText = `[User selected: ${selected}]`;
    } else {
      actionText = `[User interacted: ${action.type}]`;
    }

    // Update original message to show what was selected and disable interactivity
    const messageTs = (body as any).message?.ts;
    if (messageTs) {
      try {
        const originalBlocks: any[] = (body as any).message?.blocks || [];
        // Replace actions blocks with context showing the selection
        const updatedBlocks = originalBlocks.map((block: any) => {
          if (block.type === 'actions') {
            return {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `_${actionText.replace(/[[\]]/g, '')}_`,
                },
              ],
            };
          }
          return block;
        });
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          blocks: updatedBlocks,
          text: (body as any).message?.text || '',
        });
      } catch (err: any) {
        log(`[action] Failed to update original message: ${err?.message || err}`);
      }
    }

    // Process the action as a synthetic user message with progress updates
    await orchestrator.withChannelLock(channelId, async () => {
      const progress = new ProgressUpdater(channelId, client);
      try {
        await progress.postInitial();

        const result = await processMessage(
          channelId,
          userId,
          actionText,
          client,
          claude,
          orchestrator,
          (event) => progress.onProgress(event),
          (ts, blocks) => progress.adoptMessage(ts, blocks),
        );

        await progress.finalize(result.text, result.toolCalls, result.usage);
      } catch (err: any) {
        await progress.abort('Sorry, something went wrong processing your selection.');
      }
    });
  });

  console.log('✓ Action handlers registered');
}
