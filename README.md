# QuestWorks

QuestWorks is a task routing and coordination layer for AI agents. It pulls tasks from external systems (GitHub Issues, Jira, Beads, etc.) into a unified SQLite queue, allows agents to atomically claim and work on them, and pushes status updates back to the source system.

## Architecture

```
External Sources          QuestWorks Core              Agents
─────────────────         ──────────────────           ──────
GitHub Issues    ──────▶  adapters/          ──────▶  GET /tasks?status=open
Jira             ──────▶  sync/scheduler     ──────▶  POST /tasks/:id/claim
Beads            ──────▶  db/ (SQLite)       ──────▶  POST /tasks/:id/status
                          routes/            ◀──────  POST /tasks/:id/complete
                          mattermost/notify
```

### Task Lifecycle

Tasks flow through these statuses: `open → claimed → in_progress → review → done`

Blocked tasks can be marked `blocked` at any point and returned to `open` when unblocked.

### Task Model

```json
{
  "id": "uuid",
  "title": "string",
  "description": "string",
  "status": "open|claimed|in_progress|review|done|blocked",
  "assignee": "agent username or null",
  "claimed_at": "timestamp or null",
  "source": "adapter id string",
  "external_id": "id in source system",
  "external_url": "link back to source",
  "labels": ["string"],
  "priority": 0,
  "created_at": "timestamp",
  "updated_at": "timestamp",
  "metadata": {}
}
```

## File Structure

```
questworks/
  server.mjs              Main Express app (port 8788)
  config.yaml.example     Example configuration
  package.json
  adapters/
    base.mjs              BaseAdapter class + normalizeTask()
    github.mjs            GitHub Issues adapter stub
    jira.mjs              Jira adapter stub
    beads.mjs             Beads adapter stub
  db/
    schema.sql            SQLite schema (tasks, task_history, adapter_state)
    migrations.mjs        DB init / migration runner
  routes/
    tasks.mjs             Task CRUD + atomic claim logic
    adapters.mjs          Adapter management + manual sync
  sync/
    scheduler.mjs         Periodic pull from all adapters
  mattermost/
    notify.mjs            Post task cards, update threads
  dashboard/              Legacy WQ dashboard (keep as-is)
  questbus/               QuestBus message bus (keep as-is)
  questbus-plugin/        OpenClaw plugin for bus integration (keep as-is)
  workqueue/              Legacy JSON queue (migration path)
  Dockerfile
```

## Quick Start

```bash
# 1. Copy and edit config
cp config.yaml.example config.yaml
# Edit config.yaml — set adapter credentials, Mattermost URL, etc.

# 2. Install dependencies
npm install

# 3. Start server
npm start
# or for development with auto-reload:
npm run dev
```

The server starts on port 8788 by default. The SQLite database is created at `questworks.db` (or `$QUESTWORKS_DB`).

## Configuration

Copy `config.yaml.example` to `config.yaml`. All `$VAR` references are expanded from environment variables at startup.

```yaml
adapters:
  - id: github-quest
    type: github
    config:
      repo: owner/repo
      token: $GITHUB_TOKEN
      label_filter: "quest-team"

mattermost:
  url: $MM_URL
  token: $MM_BOT_TOKEN
  channel: paperwork

sync:
  interval_seconds: 60

server:
  port: 8788
  auth_token: $QUESTWORKS_TOKEN
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `QUESTWORKS_CONFIG` | Path to config.yaml | `./config.yaml` |
| `QUESTWORKS_DB` | Path to SQLite database | `./questworks.db` |
| `QUESTWORKS_TOKEN` | Bearer token for API auth | none (auth disabled) |
| `PORT` | HTTP listen port | `8788` |
| `DASHBOARD_DIR` | Path to dashboard static files | `./dashboard` |
| `BUS_PATH` | Path to QuestBus JSONL log | `./questbus/bus.jsonl` |

## API Reference

All write endpoints require `Authorization: Bearer <token>` if `QUESTWORKS_TOKEN` is set.

### Tasks

| Method | Path | Description |
|---|---|---|
| GET | `/tasks` | List tasks. Query: `?status=open&source=github-quest&assignee=agent1` |
| GET | `/tasks/:id` | Get single task |
| POST | `/tasks/:id/claim` | Atomically claim a task. Body: `{ "agent": "agent1" }` |
| POST | `/tasks/:id/unclaim` | Release claim. Body: `{ "agent": "agent1" }` |
| POST | `/tasks/:id/status` | Update status. Body: `{ "status": "in_progress", "agent": "agent1", "comment": "..." }` |
| POST | `/tasks/:id/complete` | Mark done + close in source. Body: `{ "agent": "agent1", "comment": "..." }` |
| POST | `/tasks/:id/comment` | Post comment. Body: `{ "agent": "agent1", "comment": "..." }` |
| GET | `/tasks/:id/history` | Get audit history for a task |

### Adapters

| Method | Path | Description |
|---|---|---|
| GET | `/adapters` | List adapters with health status and last sync info |
| POST | `/adapters/:id/sync` | Trigger manual sync for one adapter |

### Bus (QuestBus compatibility)

| Method | Path | Description |
|---|---|---|
| GET | `/bus/stream` | SSE stream of bus messages |
| POST | `/bus/send` | Send a bus message (fan-out to SSE clients + append to log) |

### System

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (no auth required) |

## Adapters

Adapters are the bridge between QuestWorks and external task systems. Each adapter implements:

- `pull()` — fetch open tasks from the source, return QuestWorks task objects
- `claim(task)` — notify the source that a task has been claimed
- `update(task, changes)` — push a status update or comment to the source
- `close(task)` — mark the task as done in the source
- `health()` — return `{ ok: bool, message: string }`

To add a new adapter type:
1. Create `adapters/mytype.mjs` extending `BaseAdapter`
2. Import and add it to the `ADAPTER_TYPES` map in `server.mjs`
3. Add an entry to `config.yaml`

## Docker

```bash
docker build -t questworks .
docker run -d \
  -p 8788:8788 \
  -v /data/questworks:/data \
  -e QUESTWORKS_TOKEN=my-secret-token \
  -e GITHUB_TOKEN=ghp_... \
  -e MM_URL=https://mattermost.example.com \
  -e MM_BOT_TOKEN=... \
  -v /path/to/config.yaml:/app/config.yaml \
  questworks
```

## Migration from v1 (workqueue JSON)

The `workqueue/` directory with `queue.json` remains in place as a migration path. The legacy dashboard at `dashboard/server.mjs` continues to read/write `queue.json` for backwards compatibility.

New tasks created in v2 go into the SQLite database. To migrate existing tasks from `queue.json` into SQLite, write a one-time import script using the `initDb` helper from `db/migrations.mjs` and insert rows directly into the `tasks` table.
