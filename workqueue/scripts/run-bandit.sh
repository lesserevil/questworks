#!/bin/bash
export MM_BASE_URL="https://quest.mass-hysteria.org"
export MM_BOT_TOKEN="1tzpsx49difhpfhxporotozeno"
export NODE_TLS_REJECT_UNAUTHORIZED=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUEUE="$SCRIPT_DIR/../queue.json"
CHANNEL_MAP="$SCRIPT_DIR/channel-map.json"

node "$SCRIPT_DIR/bandit-watchdog.mjs" --queue "$QUEUE" --channel-map "$CHANNEL_MAP" >> /tmp/bandit-watchdog.log 2>&1
