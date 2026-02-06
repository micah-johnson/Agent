# Cletus

Personal AI agent. Lives in Slack. Writes code, runs tasks, remembers everything.

## Phase 1: The Loop ✅

Basic Slack bot with Claude integration. Receives DMs, calls Claude, responds with conversation history.

## Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Configure environment:**
   - `.env` file contains Slack credentials
   - Ensure Slack app is set up with Socket Mode enabled

3. **First-time OAuth login:**
   - On first run, you'll be prompted to authenticate with Claude
   - Visit the authorization URL in your browser
   - After authorizing, copy the full redirect URL
   - Paste it back in the terminal
   - Credentials are saved to `~/.cletus/credentials.json`

4. **Run the bot:**
   ```bash
   bun dev
   ```

## Usage

Send a direct message to Cletus in Slack. It will:
- Remember conversation context within the session
- Respond using Claude Opus 4.6
- Keep the last 50 messages in history

## Architecture

```
You ←→ Cletus (Slack DM)
         ↓
      Claude Opus
```

## What's Next

- **Phase 2**: Tools (bash, file operations, agent loop)
- **Phase 3**: Orchestrator + sub-agents (parallel execution)
- **Phase 4**: Memory (logs, search, knowledge)
- **Phase 5**: Workspace awareness
- **Phase 6**: Self-improvement
- **Phase 7**: Thread support
