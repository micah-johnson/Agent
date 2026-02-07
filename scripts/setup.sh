#!/usr/bin/env bash
set -euo pipefail

# Agent setup script — installs dependencies and registers a systemd service.
# Idempotent: safe to run multiple times.

SERVICE_NAME="agent"
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$INSTALL_DIR/.env"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Detect bun
if command -v bun &>/dev/null; then
  BUN_PATH="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_PATH="$HOME/.bun/bin/bun"
else
  echo "Error: bun not found. Install it first: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# Detect user (prefer SUDO_USER for when running with sudo)
RUN_USER="${SUDO_USER:-$(whoami)}"
RUN_GROUP="$(id -gn "$RUN_USER")"

echo "Agent setup"
echo "  Install dir: $INSTALL_DIR"
echo "  Bun:         $BUN_PATH"
echo "  User:        $RUN_USER"
echo ""

# Step 1: Install dependencies
echo "Installing dependencies..."
(cd "$INSTALL_DIR" && "$BUN_PATH" install)
echo ""

# Step 2: Check .env
if [ ! -f "$ENV_FILE" ]; then
  echo "Warning: .env file not found at $ENV_FILE"
  echo "  Copy .env.example and fill in your credentials before starting."
  echo ""
fi

# Step 3: Create systemd service
if [ "$(id -u)" -ne 0 ]; then
  echo "Systemd setup requires root. Re-run with sudo:"
  echo "  sudo $0"
  exit 1
fi

echo "Creating systemd service: $SERVICE_NAME"

cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=Agent AI Agent (Slack)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$BUN_PATH run src/index.ts
Restart=on-failure
RestartSec=5

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR/data /tmp

[Install]
WantedBy=multi-user.target
UNIT

echo "  Written: $SERVICE_FILE"

# Step 4: Reload and enable
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
echo "  Service enabled (will start on boot)"

# Step 5: Start (or restart if already running)
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "  Restarting $SERVICE_NAME..."
  systemctl restart "$SERVICE_NAME"
else
  echo "  Starting $SERVICE_NAME..."
  systemctl start "$SERVICE_NAME"
fi

sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo ""
  echo "Agent is running."
  echo ""
  echo "Useful commands:"
  echo "  sudo systemctl status $SERVICE_NAME    # check status"
  echo "  sudo journalctl -u $SERVICE_NAME -f    # follow logs"
  echo "  sudo systemctl restart $SERVICE_NAME   # restart"
  echo "  sudo systemctl stop $SERVICE_NAME      # stop"
else
  echo ""
  echo "Warning: service failed to start. Check logs:"
  echo "  sudo journalctl -u $SERVICE_NAME -e"
fi
