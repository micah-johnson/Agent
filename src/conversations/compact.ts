/**
 * Conversation compaction — token-based summarize-and-reset
 *
 * When the conversation exceeds the configured token threshold,
 * we summarize it with Sonnet and replace the full history with
 * a structured summary + recent exchanges preserved verbatim.
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

const SUMMARY_PROMPT = `Create a structured summary of this conversation using the following format:

## Active Tasks
- [what we're working on, status, blockers]

## Decisions Made
- [key decisions with rationale]

## Working Files
- [file paths + brief state — don't preserve contents]

## Key Context
- [branch, environment, user corrections]

## Conversation Flow
- [high-level narrative: asked → done → status]

If you need details not in this summary, use search_memory to recover them from the conversation log.`;

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
 * Split messages into exchanges (user message + following assistant/tool messages).
 */
function splitIntoExchanges(messages: Message[]): Message[][] {
  const exchanges: Message[][] = [];
  let currentExchange: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && currentExchange.length > 0) {
      // Start of new exchange — save previous
      exchanges.push(currentExchange);
      currentExchange = [msg];
    } else {
      currentExchange.push(msg);
    }
  }

  if (currentExchange.length > 0) {
    exchanges.push(currentExchange);
  }

  return exchanges;
}

/**
 * Compress tool results in message text to reduce token usage.
 */
function compressToolResults(text: string, toolName?: string): string {
  // For bash commands that succeeded (no error indicators)
  if (toolName === 'Bash') {
    const hasError = /error|fail|exception|cannot|no such|permission denied/i.test(text);
    if (!hasError && text.length > 500) {
      return '[output: command succeeded]';
    }
  }

  // For file reads (long multi-line content without errors)
  if (toolName === 'file_read' || text.includes('\n') && text.length > 1000) {
    const hasError = /error|fail|exception|cannot|not found/i.test(text);
    if (!hasError) {
      return '[file contents omitted — re-read if needed]';
    }
  }

  // For grep/search results
  if (toolName === 'Grep' && text.length > 500) {
    const lines = text.split('\n');
    return `[search results: ${lines.length} matches found — re-run if needed]`;
  }

  // General truncation for long successful outputs
  if (text.length > 500) {
    const hasError = /error|fail|exception|cannot|denied/i.test(text);
    if (!hasError) {
      return text.substring(0, 200) + '\n[...truncated, re-obtain if needed]';
    }
  }

  return text;
}

/**
 * Build a text representation of messages for summarization, with compressed tool results.
 */
function messagesToText(messages: Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : '[complex content]';
      lines.push(`User: ${content}`);
    } else if (msg.role === 'assistant') {
      const assistant = msg as AssistantMessage;
      const text = assistant.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) {
        lines.push(`Assistant: ${text}`);
      }
      // Show tool calls
      const toolCalls = assistant.content.filter((b) => b.type === 'toolCall');
      for (const tc of toolCalls) {
        const call = tc as any;
        lines.push(`[Tool: ${call.name}]`);
      }
    } else if (msg.role === 'toolResult') {
      const tr = msg as any;
      const toolName = tr.toolName || 'unknown';
      const compressed = compressToolResults(tr.content, toolName);
      lines.push(`[Tool result: ${compressed}]`);
    }
  }

  return lines.join('\n\n');
}

/**
 * Extract existing summary from the first message if present.
 */
function extractExistingSummary(messages: Message[]): { summary: string; hasExisting: boolean } {
  if (messages.length === 0) return { summary: '', hasExisting: false };

  const firstMsg = messages[0];
  if (firstMsg.role === 'user') {
    const content = typeof firstMsg.content === 'string' ? firstMsg.content : '';
    if (content.startsWith('[Previous conversation context]')) {
      const summary = content.replace('[Previous conversation context]\n', '').trim();
      return { summary, hasExisting: true };
    }
  }

  return { summary: '', hasExisting: false };
}

/**
 * Compact a conversation by:
 * 1. Preserving the last N exchanges verbatim
 * 2. Summarizing everything before that (progressive if existing summary)
 * 3. Returning: summary message + preserved exchanges
 */
export async function compactConversation(
  messages: Message[],
  apiKey: string,
): Promise<{ messages: Message[]; summary: string }> {
  const model = getModel('anthropic', getModelSettings().compaction as any);
  const preserveCount = getAgentSettings().compactionPreserveExchanges;

  // Split into exchanges
  const exchanges = splitIntoExchanges(messages);

  // Separate preserved exchanges (last N) from compaction zone
  const preservedExchanges = exchanges.slice(-preserveCount);
  const compactionExchanges = exchanges.slice(0, -preserveCount);

  // Flatten back to messages
  const preservedMessages = preservedExchanges.flat();
  let compactionMessages = compactionExchanges.flat();

  // Check if there's an existing summary
  const { summary: existingSummary, hasExisting } = extractExistingSummary(compactionMessages);

  // If there's an existing summary, remove it from the compaction zone
  if (hasExisting && compactionMessages.length > 0) {
    compactionMessages = compactionMessages.slice(1);
  }

  // Build text for summarization
  const conversationText = messagesToText(compactionMessages);

  // Build the prompt based on whether we have existing summary
  let promptText: string;
  if (hasExisting && existingSummary) {
    promptText = `You previously summarized this conversation. Here's your previous summary:

---
${existingSummary}
---

Now fold in these new exchanges:

${conversationText}

${SUMMARY_PROMPT}`;
  } else {
    promptText = `${SUMMARY_PROMPT}

---

${conversationText}`;
  }

  const response = await completeSimple(
    model,
    {
      messages: [
        {
          role: 'user',
          content: promptText,
          timestamp: Date.now(),
        },
      ],
      systemPrompt: 'You are a helpful assistant that creates concise, structured conversation summaries.',
    },
    {
      apiKey,
      maxTokens: 2048,
      temperature: 0,
    },
  );

  const summary = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Return: summary message + preserved exchanges
  const compactedMessages: Message[] = [
    {
      role: 'user',
      content: `[Previous conversation context]\n${summary}`,
      timestamp: Date.now(),
    },
    ...preservedMessages,
  ];

  return { messages: compactedMessages, summary };
}
