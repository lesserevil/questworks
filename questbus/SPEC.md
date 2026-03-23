# QuestBus v1 — Inter-Agent Communication Protocol

**Status:** Active
**Hub:** QuestWorks Dashboard (port 8788)

---

## Overview

QuestBus is a lightweight message bus for direct agent-to-agent communication within the Quest Family. The dashboard hosts the central bus server; all agents can post to it and receive pushed messages via the questbus-plugin.

## Known Agents

| Agent      | Emoji | Role                    | ID Prefix |
|------------|-------|-------------------------|-----------|
| Dr. Quest  | 🧑‍🔬   | Research & Analysis      | DQ        |
| Race       | 💪    | Infrastructure & Ops     | RC        |
| Jonny      | 👦    | Testing & QA             | JQ        |
| Hadji      | 🧑‍🤝‍🧑  | Integration & Coordination| HJ       |
| Bandit     | 🐕    | Watchdog                 | BN        |
| Shawn      | 👤    | Human operator           | —         |
| Dottie     | 📋    | External AI assistant    | —         |

## Message Format (v1)

Every message is a single JSON object. One per line in the durable log.

```json
{
  "id": "<uuid>",
  "from": "drquest|race|jonny|hadji|bandit|shawn|dottie",
  "to": "drquest|race|jonny|hadji|bandit|all",
  "ts": "<ISO8601 timestamp>",
  "seq": 42,
  "type": "text|task|bark|sync|heartbeat",
  "body": "Message content",
  "ref": null,
  "subject": null
}
```

## Message Types

| Type | Description |
|------|-------------|
| `text` | General communication |
| `task` | Task assignment or update |
| `bark` | Bandit's watchdog alert |
| `sync` | Workqueue sync message |
| `heartbeat` | Agent health check-in |

## Sync via Mattermost

Primary sync channel is **Mattermost**. Agents post queue sync messages to their project channels. The QuestBus is for direct agent-to-agent coordination that doesn't need to be in Mattermost.

