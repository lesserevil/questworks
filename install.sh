#!/usr/bin/env bash
# install.sh — QuestWorks one-shot installer
# Run from the questworks/ directory.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_PLUGINS_DIR="${OPENCLAW_PLUGINS_DIR:-$HOME/.openclaw/plugins}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$SCRIPT_DIR}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " QuestWorks Installer"
echo " Workspace: $WORKSPACE_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Check Node.js version ─────────────────────────────────────────────────
echo "▶ Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "  ERROR: node not found. Install Node.js 22+ first."
  echo "  → https://nodejs.org  or  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  exit 1
fi

NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  ERROR: Node.js $NODE_VERSION found, but 22+ is required."
  echo "  Run: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi
echo "  ✓ Node.js v$NODE_VERSION"

# ── 2. npm install in dashboard/ ─────────────────────────────────────────────
echo ""
echo "▶ Installing dashboard dependencies..."
cd "$WORKSPACE_DIR/dashboard"
npm install --omit=dev --silent
echo "  ✓ npm install complete"
cd "$WORKSPACE_DIR"

# ── 3. Create required directories ───────────────────────────────────────────
echo ""
echo "▶ Creating required directories..."

mkdir -p "$WORKSPACE_DIR/questbus"
mkdir -p "$WORKSPACE_DIR/workqueue/results"
mkdir -p "$WORKSPACE_DIR/workqueue/scripts"

# Ensure empty log files exist
touch "$WORKSPACE_DIR/questbus/bus.jsonl"
touch "$WORKSPACE_DIR/workqueue/alerts.jsonl"
touch "$WORKSPACE_DIR/workqueue/decision-log.jsonl"
touch "$WORKSPACE_DIR/workqueue/results/.gitkeep"

echo "  ✓ questbus/"
echo "  ✓ workqueue/results/"
echo "  ✓ log files initialized"

# ── 4. Install questbus-plugin into OpenClaw ───────────────────────────────
echo ""
echo "▶ Installing questbus-plugin into OpenClaw..."

PLUGIN_SRC="$WORKSPACE_DIR/questbus-plugin"
PLUGIN_DEST="$OPENCLAW_PLUGINS_DIR/questbus-receiver"

if [ ! -d "$PLUGIN_SRC" ]; then
  echo "  WARNING: questbus-plugin/ not found at $PLUGIN_SRC — skipping"
else
  mkdir -p "$OPENCLAW_PLUGINS_DIR"
  cp -r "$PLUGIN_SRC" "$PLUGIN_DEST"
  echo "  ✓ Plugin installed to $PLUGIN_DEST"
  echo "  → Restart OpenClaw to activate: POST /questbus/receive will be available"
fi

# ── 5. Check for mc (optional) ────────────────────────────────────────────────
echo ""
echo "▶ Checking optional tools..."

if command -v mc &>/dev/null || [ -f "$HOME/.local/bin/mc" ]; then
  echo "  ✓ mc (MinIO client) found — heartbeat sync available"
else
  echo "  ℹ  mc not found — MinIO features disabled (optional)"
  echo "     To install: curl -sL https://dl.min.io/client/mc/release/linux-amd64/mc -o ~/.local/bin/mc && chmod +x ~/.local/bin/mc"
fi

# ── 6. Summary ────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Install complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit workqueue/queue.json — set \"agent\" to your agent name"
echo ""
echo "  2. Edit dashboard/server.mjs — update BUS_PEERS with your peer agents:"
echo "       bullwinkle: 'http://<puck-ip>:18789/questbus/receive',"
echo "       natasha:    'http://<sparky-ip>:18789/questbus/receive',"
echo ""
echo "  3. Start the dashboard:"
echo "       cd dashboard && node server.mjs"
echo "     Or install as systemd service (see AZURE_VM_SETUP.md)"
echo ""
echo "  4. Self-test:"
echo "       curl http://localhost:8788/api/status"
echo "       curl -X POST http://localhost:8788/bus/send \\"
echo "         -H 'Authorization: Bearer wq-dash-token-2026' \\"
echo "         -H 'Content-Type: application/json' \\"
echo "         -d '{\"from\":\"me\",\"to\":\"all\",\"body\":\"hello questworks\"}'"
echo ""
echo "  5. Restart OpenClaw to activate questbus-plugin (POST /questbus/receive)"
echo ""
echo "  See AGENTS.md for full deployment guide."
echo ""
