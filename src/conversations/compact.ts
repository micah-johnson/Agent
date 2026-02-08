/**
 * Conversation compaction — token-based summarize-and-reset
 *
 * When the conversation exceeds the configured token threshold,
 * we summarize it with Sonnet and replace the full history with
 * a single context message containing the summary.
 */

import {
  completeSimple,
  getModel,
  type Message,
  type AssistantMessage,
} from '@mariozechner/pi-ai';
import { getModelSettings, getAgentSettings } from '../config/settings.js';

export function getTokenThreshold(): number {
  return getAgentSettings().compactionTokenThreshold;
}

const SUMMARY_PROMPT =
  'Summarize this conversation concisely. Include: key facts discussed, ' +
  'decisions made, file paths mentioned, any ongoing tasks or requests, ' +
  'and the user\'s preferences or working style. ' +
  'Write it as a brief context document, not as a conversation transcript.';

/**
 * Check if the conversation needs compaction based on the last
 * assistant message's input token usage.
 */
export function needsCompaction(messages: Message[]): boolean {
  // Walk backwards to find the last assistant message with usage info
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const assistant = msg as AssistantMessage;
      const totalInput = (assistant.usage?.input ?? 0) + (assistant.usage?.cacheRead ?? 0);
      if (totalInput > getTokenThreshold()) {
        return true;
      }
      return false;
    }
  }
  return false;
}

/**
 * Compact a conversation by summarizing it with Sonnet and returning
 * a fresh message array with just the summary as context.
 */
export async function compactConversation(
  messages: Message[],
  apiKey: string,
): Promise<{ messages: Message[]; summary: string }> {
  const model = getModel('anthropic', getModelSettings().compaction as any);

  // Build a text representation of the conversation for summarization
  const conversationText = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      if (m.role === 'user') {
        const content = typeof m.content === 'string' ? m.content : '[complex content]';
        return `User: ${content}`;
      }
      const assistant = m as AssistantMessage;
      const text = assistant.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return `Assistant: ${text}`;
    })
    .join('\n\n');

  const response = await completeSimple(
    model,
    {
      messages: [
        {
          role: 'user',
          content: `${SUMMARY_PROMPT}\n\n---\n\n${conversationText}`,
          timestamp: Date.now(),
        },
      ],
      systemPrompt: 'You are a helpful assistant that creates concise conversation summaries.',
    },
    {
      apiKey,
      maxTokens: 1024,
      temperature: 0,
    },
  );

  const summary = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Return a fresh history with just the summary as context
  const compactedMessages: Message[] = [
    {
      role: 'user',
      content: `[Previous conversation context]\n${summary}`,
      timestamp: Date.now(),
    },
  ];

  return { messages: compactedMessages, summary };
}
