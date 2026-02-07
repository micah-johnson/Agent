#!/usr/bin/env bun
/**
 * Interactive setup CLI for Agent.
 * 
 * Usage: bun run setup
 * 
 * Walks through naming, credentials, workspace creation, and systemd install.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, userInfo } from 'os';
import { execSync } from 'child_process';

// ── Colors ─────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function heading(text: string) {
  console.log(`\n${c.bold}${c.cyan}═══ ${text} ═══${c.reset}\n`);
}

function success(text: string) {
  console.log(`  ${c.green}✓${c.reset} ${text}`);
}

function warn(text: string) {
  console.log(`  ${c.yellow}⚠${c.reset} ${text}`);
}

function error(text: string) {
  console.log(`  ${c.red}✗${c.reset} ${text}`);
}

function info(text: string) {
  console.log(`  ${c.dim}${text}${c.reset}`);
}

// ── Input helpers ──────────────────────────────────────────────────────

function ask(question: string, defaultValue?: string): string {
  const suffix = defaultValue ? ` ${c.dim}(${defaultValue})${c.reset}` : '';
  process.stdout.write(`  ${question}${suffix}: `);
  
  // Use Bun's prompt() — returns null if empty
  const answer = prompt('') ?? '';
  
  // Move cursor up and rewrite the line with the answer
  const value = answer.trim() || defaultValue || '';
  return value;
}

function askSecret(question: string): string {
  process.stdout.write(`  ${question}: `);
  const answer = prompt('') ?? '';
  return answer.trim();
}

function askYesNo(question: string, defaultYes = true): boolean {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = ask(question, hint);
  if (answer === hint) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

// ── Validation ─────────────────────────────────────────────────────────

function validateToken(token: string, prefix: string, name: string): boolean {
  if (!token) {
    error(`${name} is required`);
    return false;
  }
  if (!token.startsWith(prefix)) {
    warn(`${name} doesn't start with "${prefix}" — are you sure it's correct?`);
    return askYesNo('Continue anyway?', false);
  }
  return true;
}

// ── Template files ─────────────────────────────────────────────────────

function getDefaultSystemPrompt(): string {
  // Read the template from the repo's templates/
  const templatePath = join(import.meta.dir, '../../templates/system-prompt.md');
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, 'utf-8');
  }
  // Fallback minimal prompt
  return `# {{AGENT_NAME}} — Personal AI Agent

You are {{AGENT_NAME}}, a personal AI agent that lives in Slack. You help with coding tasks, run commands, manage infrastructure, and remember everything.
`;
}

function generateEnv(config: {
  workspace: string;
  agentName: string;
  slackAppToken: string;
  slackBotToken: string;
  slackUserToken: string;
  anthropicKey: string;
  voyageKey: string;
  allowedUsers: string;
}): string {
  return `# Workspace path
AGENT_WORKSPACE=${config.workspace}

# Agent name
AGENT_NAME=${config.agentName}

# Slack credentials
SLACK_APP_TOKEN=${config.slackAppToken}
SLACK_BOT_TOKEN=${config.slackBotToken}
${config.slackUserToken ? `SLACK_USER_TOKEN=${config.slackUserToken}` : '# SLACK_USER_TOKEN=xoxp-...'}

# Anthropic API key
ANTHROPIC_API_KEY=${config.anthropicKey}

# Voyage AI — embeddings for semantic search
${config.voyageKey ? `VOYAGE_API_KEY=${config.voyageKey}` : '# VOYAGE_API_KEY=pa-...'}

# Authorized Slack user IDs (comma-separated)
ALLOWED_SLACK_USERS=${config.allowedUsers}
`;
}

function generateSettings(allowedUsers: string[]): string {
  return JSON.stringify({
    permissions: {
      defaultPolicy: 'deny',
      allowedUsers,
    },
    toolApproval: {
      defaultMode: 'bypass',
      alwaysAllow: [],
    },
    codeDiffs: false,
    messageMode: 'steer',
  }, null, 2) + '\n';
}

function generateSystemdService(config: {
  agentName: string;
  serviceName: string;
  installDir: string;
  workspace: string;
  bunPath: string;
  user: string;
  group: string;
}): string {
  return `[Unit]
Description=${config.agentName} AI Agent (Slack)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
User=${config.user}
Group=${config.group}
WorkingDirectory=${config.installDir}
EnvironmentFile=${config.workspace}/.env
ExecStart=${config.bunPath} run src/index.ts
Restart=on-failure
RestartSec=5

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${config.serviceName}

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${config.workspace} /tmp

[Install]
WantedBy=multi-user.target
`;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${c.bold}${c.magenta}
   ╔═══════════════════════════════╗
   ║       Agent Setup Wizard      ║
   ╚═══════════════════════════════╝${c.reset}

  Set up your own AI agent instance.
  This will create a workspace with your config,
  credentials, and optionally install a systemd service.
`);

  // ── Step 1: Name ───────────────────────────────────────────────────

  heading('1. Name Your Agent');
  info('This name is used in the system prompt and service name.');
  const agentName = ask('Agent name', 'Agent');
  const serviceName = agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  success(`Name: ${c.bold}${agentName}${c.reset}`);

  // ── Step 2: Workspace ──────────────────────────────────────────────

  heading('2. Workspace Directory');
  info('Where to store config, data, and secrets.');
  info('This is separate from the agent code.');
  const defaultWorkspace = join(homedir(), `.${serviceName}`);
  const workspace = resolve(ask('Workspace path', defaultWorkspace));

  if (existsSync(workspace)) {
    warn(`Workspace already exists at ${workspace}`);
    if (!askYesNo('Overwrite existing config?', false)) {
      console.log('\n  Keeping existing workspace. Skipping file generation.\n');
      return;
    }
  }

  success(`Workspace: ${c.bold}${workspace}${c.reset}`);

  // ── Step 3: Slack Credentials ──────────────────────────────────────

  heading('3. Slack Credentials');
  info('Create a Slack app at https://api.slack.com/apps');
  info('Enable Socket Mode and add required scopes.');
  console.log();

  let slackAppToken = '';
  while (!slackAppToken) {
    slackAppToken = askSecret('Slack App Token (xapp-...)');
    if (!validateToken(slackAppToken, 'xapp-', 'App Token')) {
      slackAppToken = '';
    }
  }
  success('App token set');

  let slackBotToken = '';
  while (!slackBotToken) {
    slackBotToken = askSecret('Slack Bot Token (xoxb-...)');
    if (!validateToken(slackBotToken, 'xoxb-', 'Bot Token')) {
      slackBotToken = '';
    }
  }
  success('Bot token set');

  info('User token is optional — enables some extra Slack features.');
  const slackUserToken = askSecret('Slack User Token (xoxp-..., or press Enter to skip)');
  if (slackUserToken) success('User token set');
  else info('Skipped user token');

  // ── Step 4: Anthropic API Key ──────────────────────────────────────

  heading('4. Anthropic API Key');
  info('Get one at https://console.anthropic.com/settings/keys');
  console.log();

  let anthropicKey = '';
  while (!anthropicKey) {
    anthropicKey = askSecret('API Key (sk-ant-...)');
    if (!validateToken(anthropicKey, 'sk-ant-', 'Anthropic key')) {
      anthropicKey = '';
    }
  }
  success('Anthropic key set');

  // ── Step 5: Voyage AI (optional) ───────────────────────────────────

  heading('5. Voyage AI Key (Optional)');
  info('Used for semantic search embeddings. Skip if not needed.');
  info('Get one at https://dash.voyageai.com');
  console.log();

  const voyageKey = askSecret('Voyage AI Key (or press Enter to skip)');
  if (voyageKey) success('Voyage key set');
  else info('Skipped — semantic search will be disabled');

  // ── Step 6: Allowed Users ──────────────────────────────────────────

  heading('6. Authorized Slack Users');
  info('Slack user IDs that can message the bot (comma-separated).');
  info('Find your ID: Slack profile → ⋮ → Copy member ID');
  console.log();

  let allowedUsers = '';
  while (!allowedUsers) {
    allowedUsers = ask('Slack User IDs (e.g., U0XXXXXXXX)');
    if (!allowedUsers) {
      error('At least one user ID is required');
    }
  }
  const userIds = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
  success(`${userIds.length} user(s) authorized`);

  // ── Step 7: Generate Files ─────────────────────────────────────────

  heading('7. Creating Workspace');

  // Create directories
  mkdirSync(join(workspace, 'config'), { recursive: true });
  mkdirSync(join(workspace, 'data'), { recursive: true });
  success('Created directories');

  // Write .env
  const envContent = generateEnv({
    workspace,
    agentName,
    slackAppToken,
    slackBotToken,
    slackUserToken,
    anthropicKey,
    voyageKey,
    allowedUsers,
  });
  writeFileSync(join(workspace, '.env'), envContent, { mode: 0o600 });
  success('.env written (permissions: 600)');

  // Write settings.json
  writeFileSync(join(workspace, 'data', 'settings.json'), generateSettings(userIds));
  success('data/settings.json written');

  // Write knowledge.md
  writeFileSync(join(workspace, 'data', 'knowledge.md'), `# Preferences\n\n# Projects\n\n# Decisions\n\n# Patterns\n`);
  success('data/knowledge.md written');

  // Copy all template files from repo's templates/ to workspace config/
  const templatesDir = join(import.meta.dir, '../../templates');
  if (existsSync(templatesDir)) {
    const templateFiles = readdirSync(templatesDir).filter(f => !f.startsWith('.'));
    for (const file of templateFiles) {
      let content = readFileSync(join(templatesDir, file), 'utf-8');
      // Substitute placeholders
      if (file === 'system-prompt.md') {
        content = content.replaceAll('{{AGENT_NAME}}', agentName);
      }
      writeFileSync(join(workspace, 'config', file), content);
      success(`config/${file} written`);
    }
  } else {
    // Fallback: generate inline if templates dir is missing
    warn('templates/ directory not found — generating defaults inline');
    const systemPrompt = getDefaultSystemPrompt();
    writeFileSync(join(workspace, 'config', 'system-prompt.md'), systemPrompt);
    success('config/system-prompt.md written');
    writeFileSync(join(workspace, 'config', 'projects.json'), '[]\n');
    success('config/projects.json written');
    writeFileSync(join(workspace, 'config', 'cli-tools.json'), JSON.stringify({ git: { available: true }, bun: { available: true } }, null, 2) + '\n');
    success('config/cli-tools.json written');
    writeFileSync(join(workspace, 'config', 'mcp-servers.json'), JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
    success('config/mcp-servers.json written');
  }

  // ── Step 8: Systemd Service ────────────────────────────────────────

  heading('8. Systemd Service (Optional)');

  const isLinux = process.platform === 'linux';
  if (!isLinux) {
    info('Not running on Linux — skipping systemd setup.');
    info(`To run manually: AGENT_WORKSPACE=${workspace} bun run dev`);
  } else {
    const installService = askYesNo('Install systemd service?', true);

    if (installService) {
      const installDir = resolve(join(import.meta.dir, '../..'));
      
      // Find bun
      let bunPath = '';
      try {
        bunPath = execSync('which bun', { encoding: 'utf-8' }).trim();
      } catch {
        bunPath = join(homedir(), '.bun/bin/bun');
      }
      if (!existsSync(bunPath)) {
        error(`Bun not found at ${bunPath}`);
        info('Install bun: curl -fsSL https://bun.sh/install | bash');
        info('Then re-run setup.');
      } else {
        const currentUser = userInfo().username;
        const group = execSync(`id -gn ${currentUser}`, { encoding: 'utf-8' }).trim();

        const serviceContent = generateSystemdService({
          agentName,
          serviceName,
          installDir,
          workspace,
          bunPath,
          user: currentUser,
          group,
        });

        const servicePath = `/etc/systemd/system/${serviceName}.service`;

        // Check if we have write access
        try {
          writeFileSync(servicePath, serviceContent);
          success(`Service file written: ${servicePath}`);

          try {
            execSync('systemctl daemon-reload', { encoding: 'utf-8' });
            execSync(`systemctl enable ${serviceName}`, { encoding: 'utf-8' });
            success(`Service enabled: ${serviceName}`);
          } catch (e: any) {
            warn(`Could not enable service: ${e.message}`);
          }

          const startNow = askYesNo('Start the service now?', true);
          if (startNow) {
            try {
              execSync(`systemctl start ${serviceName}`, { encoding: 'utf-8' });
              success(`Service started!`);
            } catch (e: any) {
              error(`Failed to start: ${e.message}`);
              info(`Check logs: journalctl -u ${serviceName} -e`);
            }
          }
        } catch (e: any) {
          warn('Cannot write to /etc/systemd/system/ — need root privileges.');
          // Write to workspace instead
          const fallbackPath = join(workspace, `${serviceName}.service`);
          writeFileSync(fallbackPath, serviceContent);
          success(`Service file written to: ${fallbackPath}`);
          console.log();
          info('Install it manually:');
          info(`  sudo cp ${fallbackPath} ${servicePath}`);
          info(`  sudo systemctl daemon-reload`);
          info(`  sudo systemctl enable --now ${serviceName}`);
        }
      }
    } else {
      info('Skipped systemd setup.');
    }
  }

  // ── Summary ────────────────────────────────────────────────────────

  console.log(`
${c.bold}${c.green}
  ╔═══════════════════════════════════╗
  ║         Setup Complete! 🎉        ║
  ╚═══════════════════════════════════╝${c.reset}

  ${c.bold}Agent:${c.reset}     ${agentName}
  ${c.bold}Workspace:${c.reset} ${workspace}
  ${c.bold}Service:${c.reset}   ${serviceName}

  ${c.bold}Files created:${c.reset}
    ${workspace}/.env
    ${workspace}/config/  ${c.dim}(templates copied)${c.reset}
    ${workspace}/data/settings.json
    ${workspace}/data/knowledge.md

  ${c.dim}See .env.example in the repo root for variable reference.${c.reset}

  ${c.bold}Quick commands:${c.reset}
    ${c.dim}# Run manually${c.reset}
    AGENT_WORKSPACE=${workspace} bun run dev

    ${c.dim}# Service management (if installed)${c.reset}
    sudo systemctl status ${serviceName}
    sudo journalctl -u ${serviceName} -f
    sudo systemctl restart ${serviceName}

  ${c.dim}Edit ${workspace}/config/system-prompt.md to customize your agent's personality.${c.reset}
`);
}

main().catch(err => {
  error(`Setup failed: ${err.message}`);
  process.exit(1);
});
