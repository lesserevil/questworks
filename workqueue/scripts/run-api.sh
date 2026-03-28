#!/bin/bash
# QuestWorks API keep-alive
cd "$(dirname "$0")"
QUEUE="/home/shedwards/.openclaw/workspace/questworks/workqueue/queue.json"
LOG="/tmp/questworks-api.log"

while true; do
  echo "[$(date)] Starting QuestWorks API on port 3000..." >> "$LOG"
  node webhook-handler.mjs --port 3000 --queue "$QUEUE" >> "$LOG" 2>&1
  echo "[$(date)] API crashed, restarting in 5s..." >> "$LOG"
  sleep 5
done
