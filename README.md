# QuestWorks

**QuestWorks** is a multi-agent coordination layer for the Quest Family, built on top of OpenClaw. Forked from [QuestWorks](https://github.com/example/questworks) and adapted for the Quest team's operating procedures.

---

## What's Included

| Component | Description |
|-----------|-------------|
| **Job Board** | Structured JSON workqueue with priority escalation, claim management, and decision logging |
| **QuestBus** | JSONL pub/sub message bus with HTTP push fan-out and SSE streaming |
| **Dashboard** | Express HTTP server — job board UI, QuestBus viewer, metrics API |
| **questbus-plugin** | OpenClaw plugin that receives pushed bus messages as system events |
| **Bandit's Scripts** | Automation: health writer, cron-gap detector, priority escalation, activity monitor |

---

## The Quest Family

| Agent | Role | Model | ID Prefix |
|-------|------|-------|-----------|
| 🧑‍🔬 Dr. Quest | Research & Analysis | Nemotron Super 49B | `wq-DQ-` |
| 💪 Race | Infrastructure & Ops | Nemotron Super 49B | `wq-RC-` |
| 👦 Jonny | Testing & QA | Nemotron Nano 31B | `wq-JQ-` |
| 🧑‍🤝‍🧑 Hadji | Integration & Coordination | Nemotron Super 49B | `wq-HJ-` |
| 🐕 Bandit | Watchdog | Nemotron Nano 9B | `wq-BN-` |

---

## Architecture

```
Mattermost (#dragonfly, #project-*)
     ↕
OpenClaw Agents (Azure Container Instances)
     ↕
QuestWorks Hub (dashboard + QuestBus + job board)
     ↕
Bandit (heartbeat monitor, priority escalation)
```

### How It Works

1. **Projects** get Mattermost channels. All work happens in public.
2. **The Job Board** (`workqueue/queue.json`) tracks every task — who owns it, what priority, what status.
3. **Agents claim tasks**, post progress in project channels, and update the board when done.
4. **Bandit watches everything.** If an agent goes quiet on an active task (30+ min), Bandit barks in the project channel.
5. **The Dashboard** gives a live view of the board, agent activity, and the message bus.

---

## Quick Start

```bash
# 1. Unpack / clone
cd ~/.openclaw/workspace/questworks

# 2. Install dependencies
chmod +x install.sh && ./install.sh

# 3. Configure
# Edit dashboard/server.mjs — set MM_URL, agent endpoints, auth tokens

# 4. Start the dashboard
cd dashboard && node server.mjs

# 5. Verify
curl http://localhost:8788/api/status
```

---

## Operating Procedures

The full operating procedures are **pinned in #dragonfly** on Mattermost. Key points:

- Every project gets its own channel
- All activity happens in public — no DMs for project work
- Check the job board → claim a task → post progress → complete it
- Bandit barks at 30+ min silence on active tasks
- Priority escalation: idea → low (72h) → normal (48h) → high (24h)
- Never auto-escalate to urgent — that's human-only

See `workqueue/OPERATING_PROCEDURES.md` for the full document.

---

## Files

```
questworks/
├── README.md                       ← this file
├── AGENTS.md                       ← deployment guide
├── install.sh                      ← one-shot installer
├── dashboard/
│   ├── server.mjs                  ← Express hub server
│   └── package.json
├── questbus/
│   ├── SPEC.md                     ← QuestBus protocol spec
│   └── bus.jsonl                   ← durable message log
├── questbus-plugin/
│   ├── index.js                    ← OpenClaw plugin
│   ├── openclaw.plugin.json
│   └── README.md
└── workqueue/
    ├── queue.json                  ← the job board
    ├── SCHEMA.md                   ← queue item schema
    ├── OPERATING_PROCEDURES.md     ← team gospel
    ├── WORKQUEUE_AGENT.md          ← agent behavioral spec
    ├── alerts.jsonl                ← health/gap alerts
    ├── decision-log.jsonl          ← agent decision rationale
    ├── results/                    ← script outputs
    └── scripts/
        ├── bandit-watchdog.mjs     ← Bandit's heartbeat monitor
        ├── priority-escalation.mjs ← auto-escalation
        ├── agent-health-writer.mjs ← health status writer
        ├── cron-gap-detector.mjs   ← silence detector
        └── validate-queue.mjs      ← schema validator
```

---

## Key Endpoints (port 8788)

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Dashboard UI |
| `GET /api/queue` | Full job board JSON |
| `GET /api/metrics` | Agent activity summary |
| `POST /bus/send` | Post a QuestBus message |
| `GET /bus/messages` | Query bus messages |
| `GET /bus/stream` | SSE real-time feed |

---

## Credits

Forked from QuestWorks by Dr. Quest (do-host1). Adapted for the Quest Family by Dottie.
