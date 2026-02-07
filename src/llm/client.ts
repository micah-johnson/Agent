import { getModel, type Model, type Message } from '@mariozechner/pi-ai';
import { runAgentLoop, type AgentLoopUsage, type ProgressEvent } from '../agent/loop.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface ClaudeResponse {
  text: string;
  stopReason: string;
  messages: Message[];
  toolCalls: number;
  usage: AgentLoopUsage;
}

export class ClaudeClient {
  private apiKey: string;
  private model: Model | null = null;

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('ANTHROPIC_API_KEY not set. Run `claude setup-token` and add it to .env');
    }
    this.apiKey = key;
  }

  private getModel(): Model {
    if (!this.model) {
      this.model = getModel('anthropic', 'claude-opus-4-6');
    }
    return this.model;
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
