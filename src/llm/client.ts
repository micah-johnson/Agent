import {
  getModel,
  loginAnthropic,
  type OAuthCredentials,
  type Model,
} from '@mariozechner/pi-ai';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { runAgentLoop } from '../agent/loop.js';

export interface ClaudeResponse {
  text: string;
  stopReason: string;
  contentBlocks: any[];
}

const CREDENTIALS_PATH = join(homedir(), '.cletus', 'credentials.json');

export class ClaudeClient {
  private credentials: OAuthCredentials | null = null;
  private model: Model | null = null;

  constructor() {
    this.loadCredentials();
  }

  private loadCredentials(): void {
    try {
      if (existsSync(CREDENTIALS_PATH)) {
        const data = readFileSync(CREDENTIALS_PATH, 'utf-8');
        this.credentials = JSON.parse(data);
        console.log('✓ Loaded existing OAuth credentials');
      }
    } catch (error) {
      console.error('Failed to load credentials:', error);
    }
  }

  private saveCredentials(credentials: OAuthCredentials): void {
    try {
      const dir = join(homedir(), '.cletus');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
      this.credentials = credentials;
      console.log('✓ Saved OAuth credentials');
    } catch (error) {
      console.error('Failed to save credentials:', error);
    }
  }

  async login(): Promise<void> {
    console.log('\n🔐 Starting Anthropic OAuth login...\n');

    const credentials = await loginAnthropic(
      (url: string) => {
        console.log('📋 Please visit this URL to authorize:\n');
        console.log(url);
        console.log('\nAfter authorization, copy the FULL URL from your browser.\n');
      },
      async () => {
        const readline = await import('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        return new Promise((resolve) => {
          rl.question('Paste the full redirect URL here: ', (answer: string) => {
            rl.close();
            const url = new URL(answer);
            const code = url.searchParams.get('code');
            const state = url.hash.substring(1);
            resolve(`${code}#${state}`);
          });
        });
      },
    );

    this.saveCredentials(credentials);
    console.log('\n✅ Login successful!\n');
  }

  private ensureAuthenticated(): string {
    if (!this.credentials) {
      throw new Error('Not authenticated. Please run login() first.');
    }
    return this.credentials.access;
  }

  private getModel(): Model {
    if (!this.model) {
      this.model = getModel('anthropic', 'claude-opus-4-6');
    }
    return this.model;
  }

  /**
   * Send a message with tool execution support.
   * Uses the agent loop to handle tool calls automatically.
   */
  async sendMessageWithTools(
    userMessage: string,
    systemPrompt: string,
  ): Promise<ClaudeResponse> {
    const apiKey = this.ensureAuthenticated();
    const model = this.getModel();

    const result = await runAgentLoop(userMessage, {
      apiKey,
      model,
      systemPrompt,
    });

    return {
      text: result.text,
      stopReason: result.stopped ? 'stop' : 'max_iterations',
      contentBlocks: [{ type: 'text', text: result.text }],
    };
  }

  isAuthenticated(): boolean {
    return this.credentials !== null;
  }
}
