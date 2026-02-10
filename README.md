# Agent

AI agent that lives in Slack. Runs commands, writes code, manages infrastructure, remembers everything.

## Features

- **Tool use** — bash, file operations, grep, math expressions, web fetch, headless browser (Puppeteer), background processes
- **Sub-agents** — delegate long-running tasks, run work in parallel. Specialized types: worker, explorer, planner, reviewer
- **Persistent memory** — conversations, per-user knowledge base, semantic search
- **Hooks system** — lifecycle hooks for tool gating, message filtering, context injection, and more
- **Conversation persistence** — conversations survive restarts with automatic save/restore
- **Workspace awareness** — indexes projects, watches for file changes
- **Time awareness** — agent knows current date and time
- **MCP client** — connect to any Model Context Protocol server for additional tools
- **Scheduler** — cron jobs, intervals, one-shot tasks
- **Rich Slack UI** — Block Kit messages, buttons, dropdowns, file uploads
- **Canvases** — rich persistent documents in Slack for plans, reports, and documentation
- **Conversation steering** — redirect the agent mid-response
- **Context compaction v2** — progressive summarization with structured summaries, preserves recent exchanges
- **Approval gates** — optional human-in-the-loop for sensitive operations

## Prerequisites

- [Bun](https://bun.sh) runtime
- A [Slack app](https://api.slack.com/apps) with Socket Mode enabled
- [Anthropic API key](https://console.anthropic.com/settings/keys)
- [Voyage AI key](https://dash.voyageai.com) (optional, for semantic search)
- Linux with systemd (for service install — runs anywhere for dev)

## Quick Start

```bash
git clone https://github.com/micah-johnson/Agent.git
cd Agent
bun install
bun run setup
```

The setup wizard walks you through:
1. Naming your agent
2. Choosing a workspace directory
3. Entering Slack credentials
4. Entering API keys
5. Configuring authorized users
6. Installing a systemd service (optional)

## Architecture

Agent separates **code** from **workspace**:

```
Agent/                        # Code (this repo)
  src/                        # Source code
  templates/                  # Default config templates

~/.agent/                     # Workspace (created by setup)
  .env                        # Secrets & tokens
  config/
    system-prompt.md           # Agent personality & instructions
    projects.json              # Registered project paths
    mcp-servers.json           # MCP server connections
    cli-tools.json             # Available CLI tools
    hooks.json                 # Lifecycle hooks configuration
  data/
    agent.sqlite               # Conversations, tasks, memory vectors
    knowledge/                 # Persistent knowledge base
      _shared/
        persona.md             # Agent personality/behavioral rules
        projects/
          {name}.md            # Per-project knowledge
      {userId}/
        preferences.md         # User preferences
        patterns.md            # Learned patterns
    settings.json              # Permissions & behavior settings
```

The workspace path is set via `AGENT_WORKSPACE` (defaults to `~/.agent`). Upgrading the agent is just `git pull && bun install` — your workspace is untouched.

## Configuration

### Environment Variables

Core variables in `.env`:

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Optional
VOYAGE_API_KEY=pa-...          # For semantic search
TIMEZONE=America/New_York      # IANA timezone format (defaults to America/Los_Angeles)
AGENT_WORKSPACE=~/.agent       # Workspace directory
```

### System Prompt

Edit `$WORKSPACE/config/system-prompt.md` to customize your agent's personality, instructions, and behavior. The `{{AGENT_NAME}}` placeholder is replaced with your agent's name at runtime.

### Projects

Register projects in `$WORKSPACE/config/projects.json` so the agent can index and watch them:

```json
[
  {
    "name": "my-api",
    "path": "/home/user/projects/my-api",
    "description": "Main API server",
    "language": "typescript"
  }
]
```

### MCP Servers

Connect external tool servers via `$WORKSPACE/config/mcp-servers.json` (Claude Desktop format):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  }
}
```

MCP tools are automatically discovered and available to the agent and all sub-agents.

### Settings

`$WORKSPACE/data/settings.json` controls permissions and behavior:

```json
{
  "permissions": {
    "defaultPolicy": "deny",
    "allowedUsers": ["U0XXXXXXXX"]
  },
  "toolApproval": {
    "defaultMode": "bypass"
  },
  "messageMode": "steer"
}
```

**messageMode options:**
- `"steer"` (default) — allows redirecting the agent mid-response
- `"queue"` — waits for current response to finish before processing new messages

### Hooks

`$WORKSPACE/config/hooks.json` lets you run shell commands at key points in the agent lifecycle. Use hooks to gate tool calls, filter messages, inject context, or trigger external integrations.

**Hook events:**

| Event | Fires when | Use case |
|-------|-----------|----------|
| `pre_tool` | Before a tool is executed | Deny or modify tool calls |
| `post_tool` | After a tool completes | Log tool usage, post-process results |
| `on_message` | When a user message arrives | Block messages, inject context |
| `on_response` | Before the agent's response is sent | Filter or modify output |
| `on_error` | When an error occurs | Alert, log, or recover |

**Example configuration:**

```json
{
  "hooks": [
    {
      "event": "pre_tool",
      "command": "/home/user/scripts/check-tool.sh",
      "timeout": 5000
    },
    {
      "event": "on_message",
      "command": "/home/user/scripts/inject-context.sh",
      "timeout": 3000
    }
  ]
}
```

**Design:**
- **Fail-open** — hook failures (crashes, timeouts) never break the agent. The operation continues normally.
- **Exit codes:** `0` = success (stdout is parsed for directives), `2` = blocking error (operation is denied), any other code = continue as if the hook wasn't there.

## Running

### Systemd (recommended)

If you installed the service during setup:

```bash
sudo systemctl start my-agent
sudo systemctl status my-agent
sudo journalctl -u my-agent -f
```

### Manual

```bash
AGENT_WORKSPACE=~/.agent bun run start
```

### Dev

```bash
AGENT_WORKSPACE=~/.agent bun run dev
```

## Slack App Setup

Your Slack app needs:

**OAuth Scopes (Bot Token):**
- `chat:write` — send messages
- `files:write` — upload files
- `im:history` — read DMs
- `im:read` — access DM channels
- `im:write` — open DMs
- `reactions:read` — read reactions
- `users:read` — look up user info

**Socket Mode:** enabled (generates the `xapp-` app-level token)

**Event Subscriptions:**
- `message.im` — receive DMs
- `message.groups` — receive group messages (optional)

**Interactivity:** enabled (for Block Kit buttons/dropdowns)

## Manual Setup

If you prefer not to use the wizard:

1. Create a workspace directory: `mkdir -p ~/.agent/{config,data}`
2. Copy templates: `cp templates/* ~/.agent/config/`
3. Create `.env` (see `.env.example` for reference)
4. Create `data/settings.json` with your allowed user IDs
5. Run: `AGENT_WORKSPACE=~/.agent bun run start`

## License

MIT
