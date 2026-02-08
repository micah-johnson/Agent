import { getModel, type Model, type Message, type TextContent, type ImageContent } from '@mariozechner/pi-ai';
import { runAgentLoop, type AgentLoopOptions, type AgentLoopUsage, type ProgressEvent } from '../agent/loop.js';
import type { ToolRegistry } from '../tools/registry.js';
import { getModelSettings } from '../config/settings.js';

export interface ClaudeResponse {
  text: string;
  stopReason: string;
  messages: Message[];
  toolCalls: number;
  usage: AgentLoopUsage;
}

export class ClaudeClient {
  private apiKey: string;

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('ANTHROPIC_API_KEY not set. Run `claude setup-token` and add it to .env');
    }
    this.apiKey = key;
  }

  private getModel(): Model {
    return getModel('anthropic', getModelSettings().orchestrator as any);
  }

  getApiKey(): string {
    return this.apiKey;
  }

  async sendMessageWithTools(
    userMessage: string,
    systemPrompt: string,
    tools?: ToolRegistry,
    history?: Message[],
    onProgress?: (event: ProgressEvent) => void,
    signal?: AbortSignal,
    approvalGate?: (toolName: string, toolArgs: Record<string, any>) => Promise<'accept' | 'always' | 'deny'>,
    attachments?: (TextContent | ImageContent)[],
    steer?: AgentLoopOptions['steer'],
    onIntermediateText?: (text: string) => void,
  ): Promise<ClaudeResponse> {
    const model = this.getModel();

    const result = await runAgentLoop(userMessage, {
      apiKey: this.apiKey,
      model,
      systemPrompt,
      tools,
      history,
      reasoning: 'high',
      onProgress,
      signal,
      approvalGate,
      attachments,
      steer,
      onIntermediateText,
    });

    return {
      text: result.text,
      stopReason: result.stopped ? 'stop' : 'max_iterations',
      messages: result.messages,
      toolCalls: result.toolCalls,
      usage: result.usage,
    };
  }
}
