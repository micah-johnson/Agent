/**
 * Standalone OAuth login for Agent
 */

import { loginAnthropic } from '@mariozechner/pi-ai';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as readline from 'readline';

const CREDENTIALS_PATH = join(homedir(), '.agent', 'credentials.json');

console.log('\n🔐 Agent OAuth Login\n');

const credentials = await loginAnthropic(
  (url: string) => {
    console.log('📋 Please visit this URL to authorize:\n');
    console.log(url);
    console.log('\nAfter authorization, you\'ll be redirected.');
    console.log('Copy the FULL URL from your browser\'s address bar.\n');
  },
  async () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question('Paste the full redirect URL here: ', (answer: string) => {
        rl.close();
        // Extract code and state from URL
        try {
          const url = new URL(answer);
          const code = url.searchParams.get('code');
          const state = url.hash ? url.hash.substring(1) : url.searchParams.get('state');

          if (!code) {
            throw new Error('No code found in URL');
          }

          // pi-ai expects format: code#state
          const result = state ? `${code}#${state}` : code;
          resolve(result);
        } catch (error) {
          console.error('Error parsing URL:', error);
          rl.close();
          process.exit(1);
        }
      });
    });
  }
);

// Save credentials
const dir = join(homedir(), '.agent');
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));

console.log('\n✅ OAuth login successful!');
console.log(`✓ Credentials saved to ${CREDENTIALS_PATH}`);
console.log('\nYou can now run: bun dev\n');
