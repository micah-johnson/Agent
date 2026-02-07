#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Agent Restore Script
# 
# Use this if Agent breaks itself (bad code edit, corrupted files, etc.)
# It restores the codebase to the last known good state and restarts.
#
# Usage:
#   ./scripts/restore.sh              # restore to last commit
#   ./scripts/restore.sh <commit>     # restore to specific commit
#   ./scripts/restore.sh --db-only    # only restore the database, keep code
# ============================================================================

AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$AGENT_DIR/data"
BACKUP_DIR="$DATA_DIR/backups"
SERVICE_NAME="agent"
BUN_PATH="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[restore]${NC} $*"; }
warn() { echo -e "${YELLOW}[restore]${NC} $*"; }
err()  { echo -e "${RED}[restore]${NC} $*" >&2; }

# ---- Parse args ----
TARGET_COMMIT=""
DB_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --db-only)  DB_ONLY=true ;;
    --help|-h)
      echo "Usage: ./scripts/restore.sh [options] [commit]"
      echo ""
      echo "Options:"
      echo "  <commit>     Git commit hash to restore to (default: HEAD)"
      echo "  --db-only    Only restore the database backup, don't touch code"
      echo "  --help       Show this help"
      echo ""
      echo "Examples:"
      echo "  ./scripts/restore.sh                    # reset code to last commit, reinstall deps, restart"
      echo "  ./scripts/restore.sh abc1234            # restore to specific commit"
      echo "  ./scripts/restore.sh --db-only          # restore DB from latest backup"
      exit 0
      ;;
    *)          TARGET_COMMIT="$arg" ;;
  esac
done

# ---- Stop the service ----
log "Stopping Agent service..."
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  sudo systemctl stop "$SERVICE_NAME"
  log "  Service stopped"
else
  warn "  Service was not running"
fi

# ---- Database restore ----
if [ "$DB_ONLY" = true ]; then
  LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/agent.sqlite.bak.* 2>/dev/null | head -1)
  if [ -z "$LATEST_BACKUP" ]; then
    err "No database backups found in $BACKUP_DIR"
    exit 1
  fi
  log "Restoring database from: $LATEST_BACKUP"
  cp "$LATEST_BACKUP" "$DATA_DIR/agent.sqlite"
  rm -f "$DATA_DIR/agent.sqlite-shm" "$DATA_DIR/agent.sqlite-wal"
  log "  Database restored"
  
  log "Starting Agent service..."
  sudo systemctl start "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log "Agent is running again."
  else
    err "Failed to start. Check: sudo journalctl -u $SERVICE_NAME -e"
    exit 1
  fi
  exit 0
fi

# ---- Backup current state before restoring ----
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

# Backup database
if [ -f "$DATA_DIR/agent.sqlite" ]; then
  cp "$DATA_DIR/agent.sqlite" "$BACKUP_DIR/agent.sqlite.bak.$TIMESTAMP"
  log "  Database backed up to agent.sqlite.bak.$TIMESTAMP"
fi

# Backup knowledge base
if [ -f "$DATA_DIR/knowledge.md" ]; then
  cp "$DATA_DIR/knowledge.md" "$BACKUP_DIR/knowledge.md.bak.$TIMESTAMP"
  log "  Knowledge base backed up"
fi

# Stash any uncommitted changes (in case there's something worth keeping)
cd "$AGENT_DIR"
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  log "Stashing uncommitted changes..."
  git stash push -m "restore-script-backup-$TIMESTAMP" 2>/dev/null || true
fi

# ---- Git restore ----
if [ -n "$TARGET_COMMIT" ]; then
  log "Restoring to commit: $TARGET_COMMIT"
  git checkout "$TARGET_COMMIT" -- . 2>/dev/null || {
    err "Failed to checkout commit $TARGET_COMMIT"
    err "Available recent commits:"
    git log --oneline -10
    exit 1
  }
else
  log "Restoring to last commit (HEAD)..."
  git checkout HEAD -- . 2>/dev/null
  git clean -fd --exclude=data/ --exclude=.env --exclude=node_modules/ 2>/dev/null
fi

log "  Code restored"

# ---- Reinstall dependencies ----
log "Reinstalling dependencies..."
if [ -x "$BUN_PATH" ]; then
  (cd "$AGENT_DIR" && "$BUN_PATH" install 2>&1) || {
    err "bun install failed"
    exit 1
  }
  log "  Dependencies installed"
else
  err "bun not found at $BUN_PATH — install manually: cd $AGENT_DIR && bun install"
fi

# ---- Restart service ----
log "Starting Agent service..."
sudo systemctl daemon-reload
sudo systemctl start "$SERVICE_NAME"

sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  log ""
  log "✅ Agent restored and running."
  log ""
  log "What was saved:"
  log "  Code stash:  git stash list"
  log "  DB backup:   $BACKUP_DIR/agent.sqlite.bak.$TIMESTAMP"
  log "  KB backup:   $BACKUP_DIR/knowledge.md.bak.$TIMESTAMP"
else
  err ""
  err "⚠️  Agent failed to start after restore."
  err "Check logs: sudo journalctl -u $SERVICE_NAME -e"
  err ""
  err "To try a different commit:"
  err "  ./scripts/restore.sh <commit-hash>"
  err ""
  err "Recent commits:"
  git log --oneline -10
  exit 1
fi
