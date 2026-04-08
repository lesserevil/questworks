# QuestWorks Codebase Review

> Generated: 2026-04-03. For the team — covers architecture, module details, and a practical test plan.

---

## Section 1: What QuestWorks Does

### Overview

QuestWorks is a task routing and coordination layer for AI agents. It pulls tasks from external systems (GitHub Issues, Jira Server/Data Center, Beads task boards), stores them in a unified database, and lets agents atomically claim and work on them. Status updates are reflected back to the source system. Humans interact via `/qw` slash commands in Slack; agents use a REST API.

**Stack:** Node.js 22+ (ES modules), Express.js, SQLite (`better-sqlite3`) or PostgreSQL (`postgres` library), Slack Bot + Socket Mode.

---

### Entry Point: `server.mjs`

Startup sequence:

1. Load `config.yaml` (env var interpolation via `$VAR` substitution).
2. `getDb()` — selects backend: `DATABASE_URL` env var → PostgreSQL; otherwise SQLite at `QUESTWORKS_DB` or `./questworks.db`.
3. `buildAdapters()` — instantiates adapters declared in `config.yaml`.
4. `loadDbAdapters()` — loads additional adapters from the `adapters_config` DB table (decrypts config, merges into registry; DB entries override yaml for same ID).
5. Creates `SlackNotifier`.
6. Creates `SyncScheduler`.
7. Mounts Express routes (including `/slash` and `/slack` routes before `express.json()` to capture raw bodies for signature verification).
8. Starts HTTP server on `PORT` (default 8788).
9. If adapters exist: `scheduler.start()`.
10. If `SLACK_APP_TOKEN` is set: `startSocketMode()` — connects to Slack via WebSocket (Socket Mode) for slash commands, interactions, and events without requiring a public URL.

**Auth middleware**: skips `/health`, `/`, `/slash/*`, and `/slack/*`. All other routes require `Authorization: Bearer <QUESTWORKS_TOKEN>`. If `QUESTWORKS_TOKEN` is not set, auth is disabled entirely.

**Routes mounted** (order matters — Slack routes mount before `express.json()` to capture raw body for HMAC signature verification):
- `POST /slash`, `POST /slash/interactions` → `createSlashRouter()` (Slack slash commands + modal submissions)
- `POST /slack/events` → `createEventsRouter()` (Slack Events API — message events)
- `POST/GET /tasks` and sub-routes → `createTaskRoutes()`
- `GET/POST /adapters` → `createAdapterRoutes()`
- `GET /health` → inline handler (no auth)
- `GET /bus/stream` → SSE endpoint for QuestBus
- `POST /bus/send` → appends to `questbus/bus.jsonl`, fans out to SSE clients
- `GET /dashboard` → static files (if `dashboard/` dir exists)

---

### Database Layer (`db/`)

#### `db/index.mjs` — Backend Selector

Singleton factory. Returns a `SqliteDb` or `PostgresDb` based on `DATABASE_URL`:
- Unset or `sqlite://...` → `SqliteDb`
- `postgres://...` or `postgresql://...` → `PostgresDb`

Both backends share the same async interface: `query()`, `queryOne()`, `run()`, `transaction()`, `close()`.

#### `db/sqlite.mjs` — SQLite Backend

Wraps `better-sqlite3` with an async interface. Enables WAL mode and foreign keys on init. The `.raw` property exposes the raw `better-sqlite3` instance (used in tests). Transactions use `BEGIN`/`COMMIT`/`ROLLBACK` manually to support async callbacks.

#### `db/postgres.mjs` — PostgreSQL Backend

Wraps the `postgres` library. Automatically converts `?` positional placeholders to `$1`, `$2`, ... (SQLite syntax → Postgres syntax) via `toPositional()`. Nested transactions use savepoints. DSN credentials are masked in all log output. Connection pool: max 10, idle timeout 20s, connect timeout 30s.

#### Schema

Defined in `db/schema.sqlite.sql` and `db/schema.postgres.sql`. Applied idempotently on startup.

**Core tables:**

| Table | Purpose |
|-------|---------|
| `tasks` | All tasks. `UNIQUE(source, external_id)` prevents duplicates. `status` has a CHECK constraint: `open`, `claimed`, `in_progress`, `review`, `done`, `blocked`. |
| `task_history` | Append-only audit log: actor, action, old/new values, note, timestamp. FK → tasks. |
| `adapter_state` | Sync health per adapter: last_sync, task_count, status (`ok`/`error`), last_error message. |
| `conversations` | Slack multi-step flow state: user_id, channel_id, flow name, step number, JSON data blob, updated_at for TTL. |
| `adapters_config` | Encrypted adapter credentials added via `/qw adapter add *`. Columns: id, type, name, config_encrypted, status, created_at, last_sync_at. |
| `config` | Key-value store for runtime configuration (slack_channel, sync_interval_seconds, etc.). |

**Indexes:** `tasks(status)`, `tasks(source)`, `tasks(assignee)`, `task_history(task_id)`, `conversations(user_id, channel_id)`, `conversations(updated_at)`.

#### `db/crypto.mjs` — Encryption at Rest

AES-256-GCM. Key sourced from `QW_ENCRYPTION_KEY` env var (hex) or `.qw_key` file (auto-generated on first run with a warning to stderr). Functions: `encrypt(str)`, `decrypt(str)`, `encryptJson(obj)`, `decryptJson(str)`. The 12-byte IV and 16-byte auth tag are prepended to the ciphertext.

#### `db/config.mjs` — Config Helpers

`getConfig(db, key, default)`, `setConfig(db, key, value)`, `getAllConfig(db)` — thin wrappers around the `config` table using `ON CONFLICT DO UPDATE` upserts.

#### `db/adapters.mjs` — Adapter Config DB Operations

`saveAdapterConfig()`, `loadAdapterConfigs()`, `deleteAdapterConfig()`, `getAdapterConfig()`. Note: this module uses a slightly older calling convention (takes a raw `db` rather than async wrapper) — used primarily by the old `adapter_add_github.mjs` conversational flow which is now dead code (see below).

---

### Adapter System (`adapters/`)

#### `adapters/base.mjs` — BaseAdapter

All adapters extend `BaseAdapter`. Methods `pull()`, `claim()`, `update()`, `close()`, `health()` throw `not implemented` by default. `normalizeTask(raw)` converts source-specific fields to the QuestWorks task shape.

#### `adapters/http.mjs` — Shared HTTP Utilities

- **`AdapterError`**: extends `Error`. Properties: `status` (HTTP code, or `0` for network-level failures), `body` (raw response text or null).
- **`bearerAuth(token)`**: `{ Authorization: 'Bearer <token>' }`
- **`basicAuth(user, token)`**: `{ Authorization: 'Basic <base64>' }`
- **`fetchJson(url, options)`**: fetch wrapper with 429 retry logic. If `Retry-After` ≤ 60s: waits and retries once. If `> 60s`: throws immediately. Network-level failures (DNS failure, connection refused, timeout) throw `AdapterError` with `status = 0`.

#### `adapters/github.mjs` — GitHub Issues Adapter

- Auth: Bearer PAT
- `pull()`: `GET /repos/{owner}/{repo}/issues` with label filter, paginates via `Link` header
- `claim()`: POST comment `🔬 Claimed by <agent>`
- `update()`: POST comment with status/comment text
- `close()`: PATCH `state: closed` + POST `✅ Completed` comment
- `health()`: GET `/rate_limit`
- Config: `repo` (owner/repo), `token`, `label_filter`

#### `adapters/jira.mjs` — Jira Server/Data Center Adapter

- Auth: Basic Auth (username + password or PAT), `Content-Type: application/json`
- `pull()`: POST to `/rest/api/2/search` with JQL `project=X AND statusCategory != Done`, paginates 50/page
- `claim()`: PUT to assign issue (`{ name: username }`), then POST transition to "In Progress" (caches transition IDs per issue key)
- `update()`: POST plain text comment `{ body: text }` (only if `changes.comment` is set; no ADF)
- `close()`: POST transition to "Done"
- `health()`: GET `/rest/api/2/myself`
- Config: `url`, `username`, `token`, `project`, optional `jql`, `in_progress_transition`, `done_transition`

#### `adapters/beads.mjs` — Beads Task Board Adapter

- Auth: Bearer token
- `pull()`: GET tasks with pagination (`next_url` or `next_cursor`)
- `claim()`: PATCH `{ status: 'claimed', assignee }`
- `update()`: PATCH with status and/or comment
- `close()`: PATCH `{ status: 'done' }`
- `health()`: GET `/api/health`
- Config: `endpoint`, `token`, `board_id`

#### `adapters/manual.mjs` — Manual Adapter

No-op. All methods return immediately. Used for tasks created via `/qw task add manual` or `POST /tasks`.

---

### REST API Routes

All routes below require `Authorization: Bearer <QUESTWORKS_TOKEN>` when `QUESTWORKS_TOKEN` is set.

#### `routes/tasks.mjs`

| Method | Path | Body / Query | Notes |
|--------|------|------|-------|
| `POST` | `/tasks` | `{title, description?, labels?, priority?, metadata?, assignee?}` | Creates task with `source='api'`. Records history. Calls `notifier.onCreated()`. |
| `GET` | `/tasks` | `?status=&source=&assignee=` | Filters are optional, combined with AND. Ordered by priority DESC, created_at DESC. |
| `GET` | `/tasks/:id` | — | 404 if not found. |
| `POST` | `/tasks/:id/claim` | `{agent}` | **Atomic** — runs inside a DB transaction. Returns 409 if already claimed. Calls `notifier.onClaimed()`. |
| `POST` | `/tasks/:id/unclaim` | `{agent?}` | Resets to `open`, clears assignee/claimed_at. |
| `POST` | `/tasks/:id/status` | `{status, agent?, comment?}` | Any valid status. Calls `adapter.update()` async if comment present. |
| `POST` | `/tasks/:id/complete` | `{agent?, comment?}` | Sets `done`. Calls `adapter.close()` + `notifier.onCompleted()` async. |
| `POST` | `/tasks/:id/comment` | `{agent?, comment}` | Appends to history. Calls `adapter.update()` async. |
| `GET` | `/tasks/:id/history` | — | Full audit trail, newest first. |

`deserializeTask()` parses `labels` and `metadata` from JSON strings to objects on read.

#### `routes/adapters.mjs`

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/adapters` | Lists all adapters from registry + health from `adapter_state`. |
| `POST` | `/adapters/:id/sync` | Triggers `scheduler.syncAdapter(id)` for one adapter. |

---

### Sync Scheduler (`sync/scheduler.mjs`)

`SyncScheduler(db, adapterRegistry, notifier, intervalSeconds)`:

- `start()`: sets an interval (default 60s) + runs `syncAll()` immediately.
- `stop()`: clears the interval.
- `syncAll()`: iterates all adapters, calls `syncAdapter()` for each. Errors are logged but don't block other adapters.
- `syncAdapter(id)`:
  1. Calls `adapter.pull()` → array of normalized tasks.
  2. Runs a single DB transaction: for each task, checks if it exists, then `INSERT ... ON CONFLICT(source, external_id) DO UPDATE SET ... WHERE tasks.status = 'open'` — the `WHERE` clause means claimed/in-progress tasks are never overwritten by a sync.
  3. Tracks which task IDs were genuinely new (didn't exist before upsert).
  4. For each new task: calls `notifier.onNewTask()`, stores the returned Slack `ts` in `metadata.slack_ts`.
  5. Upserts `adapter_state` with `last_sync`, `task_count`, `status='ok'` on success or `status='error'` + `last_error` on failure.

---

### Slack Integration (`slack/`)

#### `slack/notify.mjs` — Slack Notifier

Posts task cards to a Slack channel and threads follow-up messages. Uses `chat.postMessage` with Block Kit blocks.

- `onNewTask(task)` — posts a task card, returns the Slack message timestamp (`ts`) on success or `undefined` on failure. The scheduler stores the `ts` in `metadata.slack_ts`.
- `onClaimed(task)` — posts a "claimed by" reply in the task's thread if `task.metadata.slack_ts` is set; standalone post otherwise.
- `onCompleted(task)` — posts a completion reply in the task's thread.
- Disabled (no-op) if `token` is not configured.

Channel resolution: `_getChannelId()` calls `conversations.list` to resolve a channel name to an ID; result is cached for the lifetime of the notifier instance.

#### `slack/api.mjs` — Shared Slack Helpers

Shared utilities used by both `slash.mjs` and `socket.mjs`:

- `slackPost(path, body, token)` — POST to `https://slack.com/api/<path>`, returns parsed JSON or `null` on failure.
- `postToSlack(channelId, text, token)` — post a plain text message to a channel.
- `openSlackModal(triggerId, modalDef, token)` — call `views.open` with a Block Kit modal definition.
- `COMMAND_MAP` — ordered array of `{ prefix, flowName }` mappings for all `/qw` subcommands.
- `parseCommand(text)` — iterates `COMMAND_MAP` in order, returns `{ flowName, args }` or `null`.

#### `slack/slash.mjs` — Slash Command HTTP Router

Handles `POST /slash` (slash command payloads) and `POST /slash/interactions` (modal submissions). Mounts before `express.json()` in `server.mjs`; uses its own `express.urlencoded()` body parser with a `verify` callback to capture the raw request body for HMAC signature verification.

**`POST /slash` flow:**
1. Verifies Slack request signature (`X-Slack-Signature` / `X-Slack-Request-Timestamp`).
2. Responds `200 OK` immediately (Slack requires acknowledgement within 3s).
3. Parses command via `parseCommand()`, deletes any existing conversation for this user+channel (fresh start).
4. Calls `flow.start(db, userId, channelId, args)`.
5. If result has `{ modal: true, modalDef }`: calls `openSlackModal()` with the `trigger_id` from the slash payload.
6. Otherwise: posts `result.message` to channel; if `result.done === false`, inserts a `conversations` row at step 0.

**`POST /slash/interactions` flow:**
1. Verifies Slack request signature.
2. Responds `200 OK` immediately.
3. Parses `payload` JSON from the form body. Handles `view_submission` type.
4. Calls `handleModalSubmit(db, payload, adapters, scheduler)`.
5. Posts result message to the originating channel.

**`handleConversationReply(db, post, token)`:**
1. Looks up active conversation for `user_id + channel_id`.
2. TTL check.
3. Calls `flow.step(db, conv, message)`.
4. Posts reply, then either deletes (done) or updates (step/data) the conversation.

#### `slack/events.mjs` — Slack Events API Router

Handles `POST /slack/events`. Supports:
- **URL verification challenge** (`type: 'url_verification'`): responds with `challenge` value.
- **`event_callback`** with `type: 'message'` (non-subtype, non-bot): routes to `handleConversationReply()` for multi-step flow continuations.

#### `slack/socket.mjs` — Socket Mode Client

`startSocketMode(db, adapters, scheduler, { token, appToken })` — connects to Slack via WebSocket using the App-Level Token (`xapp-...`). No public URL required.

Startup: calls `apps.connections.open` to get a WebSocket URL, then opens a `ws` connection.

Envelope routing:
- `slash_commands` → `handleSlashCommand()` (same logic as `POST /slash`)
- `interactive` → `handleInteraction()` (same logic as `POST /slash/interactions`)
- `events_api` → `handleEventCallback()` (same logic as `POST /slack/events`)
- `disconnect` → closes connection and reconnects

Each envelope is acknowledged immediately: `ws.send(JSON.stringify({ envelope_id }))`.

Auto-reconnects with exponential backoff (2s → 30s max) on disconnect.

#### `slack/flows/index.mjs` — All Slash Flows

All flows are defined inline in this single file. Each flow exports `{ start, step }`.

**Modal-based flows** (return `{ modal: true, done: true, modalDef }` from `start()`):
- `adapter_add_github`: 4 Block Kit input fields — repo, token, label, name
- `adapter_add_beads`: 4 fields — endpoint, token, board_id, name
- `adapter_add_jira`: 5 fields — url, token, project, name (no username; Jira Server uses Bearer auth)

`handleModalSubmit()` extracts values from Slack's nested `view.state.values` structure (`{ block_id: { action_id: { type, value } } }` → flat `{ block_id: value }`), then delegates to `handleDialogSubmit()` which validates, encrypts, inserts into `adapters_config`, instantiates the adapter, and triggers background sync.

**Multi-step conversational flows:**

| Flow | Steps | What it does |
|------|-------|--------------|
| `adapter_list` | 0 (immediate) | Lists adapters from DB with masked tokens |
| `adapter_remove` | 2 | Step 0: enter adapter ID; Step 1: yes/no confirm |
| `adapter_sync` | 1 | Enter adapter ID or `all` |
| `task_list` | 0 (immediate) | Lists up to 20 open tasks |
| `task_claim` | 1 | Lists open tasks → enter number/ID prefix → atomic UPDATE WHERE status='open' |
| `task_done` | 2 | Step 0: select task; Step 1: optional note → set status='done' |
| `task_block` | 2 | Step 0: select task; Step 1: blocking reason → set status='blocked' |
| `task_add` | 1-4 | Step 0: source type; then type-specific steps (for manual: title, description, priority) |
| `config_set_channel` | 1 | Enter channel name (strips `#` prefix) → upsert `slack_channel` in config table |
| `config_set_sync_interval` | 1 | Enter seconds (min 10) → upsert config |
| `config_show` | 0 (immediate) | Reads all config rows; masks keys containing `token`/`secret` |
| `help` | 0 (immediate) | Returns full command listing |

---

### Task Lifecycle

```
         ┌──────────────────────────────────────────┐
         │                                          │
open ──→ claimed ──→ in_progress ──→ review ──→ done
  ↑          ↓             ↓
  └──unclaim─┘         blocked ←──────────────────
```

- `open`: synced from source, waiting to be claimed
- `claimed`: atomically assigned to an agent (DB transaction)
- `in_progress`: agent has started work (via `/tasks/:id/status`)
- `review`: agent has submitted for review
- `done`: completed; triggers `adapter.close()` + `notifier.onCompleted()`
- `blocked`: agent is stuck; reason recorded in `task_history`

All status transitions are recorded in `task_history` with actor, old value, new value, and optional note.

**Task model:**
```json
{
  "id": "uuid",
  "title": "string",
  "description": "string | null",
  "status": "open | claimed | in_progress | review | done | blocked",
  "assignee": "string | null",
  "claimed_at": "ISO8601 | null",
  "source": "adapter-id or 'api' or 'manual'",
  "external_id": "id in source system",
  "external_url": "url | null",
  "labels": ["string"],
  "priority": 0,
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "metadata": { "slack_ts": "..." }
}
```

---

### Config System

Config is loaded from `config.yaml` at startup with `$ENV_VAR` interpolation. Runtime overrides are stored in the `config` DB table (set via `/qw config set *` or directly). The DB config takes effect immediately for most settings (channel, token); sync interval requires restart.

Key environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `QUESTWORKS_CONFIG` | `./config.yaml` | Config file path |
| `QUESTWORKS_DB` | `./questworks.db` | SQLite DB path |
| `DATABASE_URL` | — | Postgres DSN (triggers Postgres backend) |
| `PORT` | `8788` | HTTP listen port |
| `QUESTWORKS_TOKEN` | — | API Bearer token (auth disabled if unset) |
| `QW_ENCRYPTION_KEY` | auto | AES-256 key as hex string |
| `SLACK_TOKEN` | — | Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | — | Slack signing secret (request verification) |
| `SLACK_APP_TOKEN` | — | Slack app-level token (`xapp-...`, enables Socket Mode) |
| `DASHBOARD_DIR` | `./dashboard` | Static dashboard files |
| `BUS_PATH` | `./questbus/bus.jsonl` | QuestBus append log |

---

## Section 2: What Needs Testing & How

### Live Environment

- Container: `10.0.1.13:8788` (Azure VNet, `shedwards-quest` resource group)
- Health: `{"ok":true,"backend":"postgres","db":"postgres","adapters":1}`
- One adapter loaded: Jira, id `e947a4f3-02d4-48fc-a00f-ebb8b781e7f2`, **failing with HTTP 0 every 60s**
- Slack bot: Socket Mode active when `SLACK_APP_TOKEN` is set; HTTP endpoints (`/slash`, `/slack/events`) are always available as fallback
- Auth token required for `/tasks` and `/adapters` routes

---

### 1. Jira Adapter Failing with HTTP 0 — Diagnosis

**What HTTP 0 means:** `AdapterError` uses `status = 0` specifically for network-level failures — when `fetch()` throws before receiving any HTTP response. This is set in `adapters/http.mjs:96`:
```javascript
} catch (err) {
  throw new AdapterError(err.message, 0, null);
}
```
The Jira adapter logs this as `[jira:<id>] pull() failed: HTTP 0`.

**Root cause candidates (in order of likelihood for Azure deployment):**

1. **Outbound network blocked at the network level.** The container is on an Azure VNet (`10.0.1.13`). If the VNet has no internet gateway/NAT, or if an NSG rule blocks outbound HTTPS (port 443), all Jira API calls will fail with connection refused or timeout — both surface as `status = 0`. **Check:** can the container reach the Jira host? Run `curl -v https://<jira-url>/rest/api/2/myself` from inside the container.

2. **Missing or blank `username` field in the stored adapter config.** If `username` is empty/undefined, `basicAuth('', token)` produces a malformed `Authorization: Basic <base64(':token')>` header. Jira Server would return HTTP 401. Verify the stored config in `adapters_config` has a non-empty `username` field.

3. **Malformed Jira URL in stored config.** If the URL was entered with a trailing path, typo, or wrong scheme, `this.baseUrl` will produce a URL that resolves to nothing. Verify the stored URL with:
   ```sql
   -- On the container, connect to postgres and check:
   SELECT id, type, name FROM adapters_config;
   -- Then decrypt the config to see the URL (requires QW_ENCRYPTION_KEY)
   ```
   Or from inside the app, use `/qw adapter list` in Slack to see the masked config.

4. **DNS resolution failure.** The container can't resolve the Jira hostname. Check `/etc/resolv.conf` and test with `nslookup <jira-host>` from inside the container.

**Diagnosis steps:**

```bash
# 1. Verify container has outbound network access to Jira:
docker exec <container> curl -sv https://<jira-host> -o /dev/null 2>&1 | head -20

# 2. Check what's in the adapter config (requires DB access):
# On the Postgres host:
psql $DATABASE_URL -c "SELECT id, type, name, status, last_sync_at FROM adapters_config;"
psql $DATABASE_URL -c "SELECT adapter_id, last_sync, last_error, status FROM adapter_state;"

# 3. Check container logs for the actual error message (not just "HTTP 0"):
# The AdapterError message is err.message from the fetch() throw, e.g.:
# "fetch failed", "ECONNREFUSED", "getaddrinfo ENOTFOUND", "certificate verify failed"
docker logs <container> 2>&1 | grep jira

# 4. Test Jira credentials directly from the container:
docker exec <container> curl -u 'username:PASSWORD_OR_PAT' \
  'https://jira.yourco.com/rest/api/2/myself'
```

---

### 2. `/qw` Slash Commands from Slack

The `/qw` slash command must be registered in your Slack app and pointed at `<server>/slash` (HTTP mode) or handled automatically via Socket Mode (`SLACK_APP_TOKEN` set).

**Test matrix:**

| Command | Expected behavior |
|---------|-------------------|
| `/qw help` | Immediate reply with full command listing |
| `/qw task list` | Lists open tasks (or "0 open tasks" if empty) |
| `/qw task add` → `manual` → `My Task` → *(description)* → `2` | Creates task, confirms with ID |
| `/qw task claim` → `1` | Claims first open task, confirms |
| `/qw task done` → `1` → *(note)* | Marks task done |
| `/qw task block` → `1` → `Waiting on creds` | Marks task blocked |
| `/qw adapter list` | Lists configured adapters with masked tokens |
| `/qw adapter add github` | Opens Block Kit modal with 4 fields |
| `/qw adapter add jira` | Opens Block Kit modal with 5 fields |
| `/qw adapter sync` → *(id)* | Queues sync for named adapter |
| `/qw adapter remove` → *(id)* → `yes` | Removes adapter after confirmation |
| `/qw config show` | Shows all config values, masking tokens |
| `/qw config set channel` → `questworks` | Sets Slack notification channel |
| `/qw config set sync-interval` → `30` | Sets sync interval |

**Conversation TTL:** If you take more than 5 minutes between steps in a multi-step flow, the conversation expires silently. A fresh `/qw` command always cancels any in-progress conversation for that user+channel.

**Modal flows:** `/qw adapter add github|jira|beads` open a Slack Block Kit modal using the `trigger_id` from the slash payload. The modal submission is handled at `POST /slash/interactions` (HTTP) or via the `interactive` envelope in Socket Mode — no public URL needed when using Socket Mode.

---

### 3. REST API Endpoints

Base URL: `http://10.0.1.13:8788` (from inside the Azure VNet). Set `TOKEN` to the value of `QUESTWORKS_TOKEN`.

```bash
TOKEN="<your token>"
BASE="http://10.0.1.13:8788"

# Health (no auth):
curl $BASE/health

# List all open tasks:
curl -H "Authorization: Bearer $TOKEN" "$BASE/tasks?status=open"

# Create a task:
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test task","description":"Created via API","priority":2}' \
  $BASE/tasks

# Get a specific task:
curl -H "Authorization: Bearer $TOKEN" $BASE/tasks/<id>

# Claim a task:
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"myagent"}' \
  $BASE/tasks/<id>/claim

# Update status to in_progress:
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress","agent":"myagent"}' \
  $BASE/tasks/<id>/status

# Add a comment (also pushes to source adapter):
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"myagent","comment":"Progress update"}' \
  $BASE/tasks/<id>/comment

# Mark complete (triggers adapter.close()):
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"myagent","comment":"All done"}' \
  $BASE/tasks/<id>/complete

# Get audit history:
curl -H "Authorization: Bearer $TOKEN" $BASE/tasks/<id>/history

# List adapters + health:
curl -H "Authorization: Bearer $TOKEN" $BASE/adapters

# Trigger manual sync for one adapter:
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/adapters/<id>/sync
```

**Race condition test** (atomic claim): send two simultaneous claim requests for the same task — the second should receive HTTP 409 `{"error":"already claimed"}`.

---

### 4. GitHub Adapter Setup and Sync

**Via dialog:** `/qw adapter add github` → fill in repo (`owner/repo`), PAT, label filter, optional name → Submit.

**Manual verification:**
```bash
# Trigger sync immediately:
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/adapters/<id>/sync

# Check adapter state:
curl -H "Authorization: Bearer $TOKEN" $BASE/adapters

# Verify tasks appeared:
curl -H "Authorization: Bearer $TOKEN" "$BASE/tasks?source=github"
```

**Things to verify:**
- Label filter works (only issues with matching label are pulled)
- Pagination works for repos with > 30 open issues
- `claim()` posts a comment to the GitHub issue
- `close()` closes the issue on GitHub and posts a comment

---

### 5. Task Notifications to Slack

When `syncAdapter()` discovers a new task (not previously in DB), it calls `notifier.onNewTask(task)`. The notifier:
1. Resolves the notification channel name → ID (`conversations.list`).
2. Posts a Block Kit card (title, source, priority, labels, description snippet) via `chat.postMessage`.
3. Returns the message timestamp (`ts`); the scheduler stores it in `metadata.slack_ts`.

**Subsequent updates** (`onClaimed()`, `onCompleted()`) post as thread replies using `thread_ts: metadata.slack_ts`.

**Verify:**
- Add a GitHub/Jira adapter pointing to a repo/project with open issues
- Wait for first sync (60s default) or trigger manually
- Confirm card appears in the `questworks` (or configured) Slack channel
- Claim the task via API: `POST /tasks/<id>/claim`
- Confirm thread reply appears under the same card

**If notifications are silent:** check that `SLACK_TOKEN` is set and the bot has been invited to the target channel. The notifier fails silently (logs errors but doesn't throw).

---

### 6. Socket Mode / Conversation Flow

Socket Mode connects at startup when `SLACK_APP_TOKEN` is set. To test multi-step flows end-to-end:

1. Run `/qw task add` in Slack.
2. Bot replies: "Add a task. Source type? Options: github, jira, beads, manual"
3. Reply `manual` in the same channel.
4. Bot replies: "Enter the task title:"
5. Reply with a title.
6. Continue through description and priority prompts.

The `conversations` table stores the state. You can inspect it:
```sql
SELECT user_id, channel_id, flow, step, updated_at FROM conversations;
```

**TTL:** If you wait > 5 minutes between replies, the conversation expires and the next message is silently ignored.

**Socket Mode vs. HTTP:** Both paths share `handleConversationReply()` logic. When Socket Mode is active, incoming Slack messages arrive via the WebSocket envelope; when using HTTP, they arrive via `POST /slack/events`. Either way, the conversation state machine is identical.

---

### 7. Unit Tests — Current State

**Run:** `npm test` (uses Node.js built-in `node:test`)

**Test files:**

| File | Description |
|------|-------------|
| `tests/slack/slash-flows.test.mjs` | 47 tests across 17 suites covering `parseCommand`, all slash flows, modal structure, TTL, token masking, `handleModalSubmit` |
| `tests/slack/notify.test.mjs` | 12 tests for `SlackNotifier` thread tracking (`slack_ts`, `thread_ts`, disabled notifier) |
| `tests/adapters/jira.integration.test.mjs` | Live integration tests against a real Jira Server (skipped unless env vars set) |

**Key test assertions:**

- T3 (`adapter_add_github`): `start()` returns `{ modal: true, modalDef: { type: 'modal', blocks: [...] } }`, Block Kit `plain_text_input` elements with correct `block_id` and `action_id: 'input'`; `dialog` key is absent.
- T10 (`config_set_channel`): stores `slack_channel` key, not `mm_channel`.
- T16 (`handleModalSubmit`): extracts flat `{ block_id: value }` from Slack's nested `view.state.values` structure.
- Notify T6/T8: `onClaimed()` / `onCompleted()` include `thread_ts` when `metadata.slack_ts` is present.
- Notify T12: `onNewTask()` posts to `/chat.postMessage` with `channel` set to resolved channel ID.

---

### 8. PostgreSQL Backend

The live deployment uses Postgres (`"backend":"postgres"` in health endpoint).

**Key issues to verify:**

**`ON CONFLICT DO NOTHING` syntax:** SQLite supports both `INSERT OR IGNORE` and `INSERT ... ON CONFLICT DO NOTHING`. Postgres only supports the `ON CONFLICT` syntax. The codebase uses `ON CONFLICT` throughout — there is a pending PR from Race converting any remaining `INSERT OR IGNORE` statements. Verify all SQL in the codebase uses `ON CONFLICT DO NOTHING` not `INSERT OR IGNORE`:

```bash
grep -r "INSERT OR IGNORE" .
```
If any appear outside of tests or comments, they will fail on Postgres.

**Placeholder conversion:** `db/postgres.mjs:toPositional()` converts `?` to `$1, $2, ...`. This is applied to all SQL before sending to Postgres. Verify with the existing integration tests (T5, T6, T7 all touch the DB).

**Transactions:** Postgres uses `sql.begin()` for top-level transactions and `sql.savepoint()` for nested. The atomic claim in `routes/tasks.mjs:74` uses `db.transaction()` — verify this works correctly under Postgres by testing `/tasks/:id/claim` with concurrent requests.

**Pending PR: Jonny's PR #4 (`fix/adapter-insert-status`):** Adds `status='active'` on adapter inserts. This is already merged (commit `2f465b9`). The `adapters_config` table has `status TEXT DEFAULT 'active'` in the schema, but explicit inserts in `handleDialogSubmit()` already include `'active'` after that fix. Verify:
```sql
SELECT id, type, name, status FROM adapters_config;
-- All rows should show status='active'
```

**Race's branch (ON CONFLICT DO NOTHING):** Check if there are any remaining `INSERT OR IGNORE` statements that would break on Postgres. If Race's branch hasn't been merged yet, cherry-pick or merge before any Postgres testing.

---

### 9. End-to-End Test Checklist

For a complete smoke test of the live deployment:

```
[ ] GET /health → {"ok":true,"backend":"postgres",...}
[ ] GET /tasks (with token) → 200, array
[ ] POST /tasks (with token) → 201, task with "source":"api"
[ ] GET /tasks?status=open → only open tasks
[ ] POST /tasks/:id/claim {"agent":"test"} → 200, status="claimed"
[ ] POST /tasks/:id/claim again → 409 "already claimed"
[ ] POST /tasks/:id/status {"status":"in_progress"} → 200
[ ] GET /tasks/:id/history → array with create+claim+status entries
[ ] POST /tasks/:id/complete {"agent":"test"} → 200, status="done"
[ ] GET /adapters → 200, list (Jira adapter shows status from adapter_state)
[ ] POST /adapters/:id/sync → triggers pull, check logs for error or success
[ ] /qw help in MM → full command list posted by bot
[ ] /qw task list → open tasks
[ ] /qw adapter list → shows Jira adapter with masked token
[ ] /qw adapter add github → dialog opens with 4 fields
[ ] Fill dialog → adapter created, sync triggered
[ ] Wait 60s or trigger sync → tasks appear from GitHub
[ ] New task notification appears in MM channel
[ ] /qw task claim → pick a task → confirmed
[ ] Thread reply appears in MM under task card
[ ] /qw task done → task done → completion reply in thread
[ ] Verify Jira HTTP 0 root cause (see diagnosis above)
```

---

### Notes on Open Work

- **Existing Jira adapters need re-adding:** The adapter now uses `username` instead of `email` in the config. Any Jira adapters added before this change will have an `email` field in stored config but not `username`, causing Basic Auth to be malformed. Remove and re-add them via `/qw adapter add jira`.

- **Sync interval restart required:** Setting sync interval via `/qw config set sync-interval` only takes effect after server restart. The scheduler does not hot-reload this value.

- **`notifier.onCreated` is called but not defined** (`slack/notify.mjs`): `routes/tasks.mjs:35` calls `notifier.onCreated?.(task)`. `SlackNotifier` does not implement `onCreated`. The optional chaining means it silently does nothing. If you want notifications on API-created tasks, `onCreated` needs to be implemented (same as `onNewTask`).
