/**
 * One-time OAuth login script
 * Completes the OAuth flow with a provided callback URL
 */

import { loginAnthropic } from '@mariozechner/pi-ai';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const callbackUrl = process.argv[2];

if (!callbackUrl) {
  console.error('Usage: bun scripts/oauth-login.ts <callback-url>');
  process.exit(1);
}

// Extract code and state from URL
const url = new URL(callbackUrl);
const code = url.searchParams.get('code');
const state = url.hash ? url.hash.substring(1) : url.searchParams.get('state');

if (!code || !state) {
  console.error('Invalid callback URL. Missing code or state.');
  process.exit(1);
}

console.log('✓ Extracted OAuth code and state');
console.log(`Code: ${code.substring(0, 20)}...`);
console.log(`State: ${state.substring(0, 20)}...`);

const CREDENTIALS_PATH = join(homedir(), '.agent', 'credentials.json');

console.log('\n🔐 Completing OAuth flow...\n');

try {
  const credentials = await loginAnthropic(
    (authUrl: string) => {
      // This callback won't be used since we already have the code
      console.log('OAuth authorization already completed');
    },
    async () => {
      // Return the code#state format that pi-ai expects
      return `${code}#${state}`;
    }
  );

  // Save credentials
  const dir = join(homedir(), '.agent');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));

  console.log('✅ OAuth login successful!');
  console.log(`✓ Credentials saved to ${CREDENTIALS_PATH}`);
  console.log('\nYou can now run: bun dev\n');
} catch (error) {
  console.error('❌ OAuth login failed:', error);
  process.exit(1);
}
