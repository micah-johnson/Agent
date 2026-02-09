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
import { isUserAllowed } from '../config/settings.js';
import { parseApprovalAction, resolveApproval, addToSessionWhitelist } from '../tools/approval.js';

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

    // Auth check — use settings module
    if (!isUserAllowed(userId)) return;

    // ── Tool approval buttons ──────────────────────────────────────
    const actionId = (action as any).action_id || '';
    const approval = parseApprovalAction(actionId);
    if (approval) {
      // For "always", also add to session whitelist
      if (approval.decision === 'always') {
        // Extract tool name from the message text (format: "🔧 *toolName*\n...")
        const msgText = (body as any).message?.blocks?.[0]?.text?.text || '';
        const toolMatch = msgText.match(/\*(\w+)\*/);
        if (toolMatch) {
          addToSessionWhitelist(channelId, toolMatch[1]);
          log(`[approval] Always-allow "${toolMatch[1]}" for channel ${channelId}`);
        }
      }

      const resolved = resolveApproval(approval.approvalId, approval.decision);
      log(`[approval] ${approval.decision} for ${approval.approvalId} (resolved: ${resolved})`);

      // Update the approval message to show what was decided
      const messageTs = (body as any).message?.ts;
      if (messageTs) {
        const originalBlocks: any[] = (body as any).message?.blocks || [];
        const decisionLabel = approval.decision === 'accept' ? '✓ Accepted'
          : approval.decision === 'always' ? '✓✓ Always Accepted'
          : '✗ Denied';
        const updatedBlocks = originalBlocks.map((block: any) => {
          if (block.type === 'actions') {
            return {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `_${decisionLabel}_` }],
            };
          }
          return block;
        });
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          blocks: updatedBlocks,
          text: (body as any).message?.text || '',
        }).catch((err: any) => log(`[approval] Failed to update message: ${err?.message}`));
      }

      return; // Don't process as a conversation message
    }

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
      const signal = orchestrator.createAbortSignal(channelId);
      const progress = new ProgressUpdater(channelId, client);
      orchestrator.setActiveProgress(channelId, progress);

      try {
        progress.postInitial(); // Non-blocking

        const result = await processMessage(
          channelId,
          userId,
          actionText,
          client,
          claude,
          orchestrator,
          (event) => progress.onProgress(event),
          (ts, blocks) => progress.adoptMessage(ts, blocks),
          signal,
        );

        if (!signal.aborted) {
          await progress.finalize(result.text, result.toolCalls, result.usage);
        }


      } catch (err: any) {
        if (!signal.aborted) {
          await progress.abort('Sorry, something went wrong processing your selection.');
        }
      } finally {
        orchestrator.clearAbortSignal(channelId);
      }
    });
  });

  console.log('✓ Action handlers registered');
}
