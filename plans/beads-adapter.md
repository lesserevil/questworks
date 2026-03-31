# Plan: Beads Adapter Implementation

**Author:** Race Bannon  
**Status:** Draft — pending security/sanity review  
**Depends on:** `plans/adapter-shared-utils.md` (use `AdapterError`, `bearerAuth()`, `fetchJson()` from `adapters/http.mjs`)

---

## Overview

Implement the `BeadsAdapter` class in `adapters/beads.mjs` to bridge a Beads instance with QuestWorks. The adapter polls an open-task endpoint, claims and updates tasks via REST PATCH, and reports health via the Beads health endpoint.

Beads uses a standard REST API with bearer token auth. All methods delegate HTTP to the shared `fetchJson()` / `bearerAuth()` from `adapters/http.mjs`.

---

## Beads API Reference

All requests to `{endpoint}/api/...`. Auth via `Authorization: Bearer <token>` (use `bearerAuth()` from shared utils).

| Operation | Method | Path | Body |
|---|---|---|---|
| List open tasks | GET | `/api/boards/{board_id}/tasks?status=open` | — |
| Get single task | GET | `/api/tasks/{id}` | — |
| Claim task | PATCH | `/api/tasks/{id}` | `{ "status": "claimed", "assignee": "<agent>" }` |
| Update task | PATCH | `/api/tasks/{id}` | `{ "status"?: "...", "comment"?: "..." }` |
| Close task | PATCH | `/api/tasks/{id}` | `{ "status": "done" }` |
| Health check | GET | `/api/health` | — |

Pagination: If the response includes a `next_cursor` or `next_url` field, follow it. If absent, treat as single-page. (Design conservatively — handle both paginated and non-paginated responses gracefully.)

---

## Configuration

Config fields (from `config.yaml`, env-expanded):

| Field | Required | Description |
|---|---|---|
| `endpoint` | Yes | Base URL of Beads instance (no trailing slash) |
| `token` | Yes | Bearer token for Beads API |
| `board_id` | Yes | ID of the Beads board to pull from |

All three are required. If any are missing, `health()` returns `{ ok: false }` and `pull()` returns `[]` with a log warning (no API call made).

---

## Method Requirements

### `pull()`

- If any of `endpoint`, `token`, `board_id` not set: log warning, return `[]` (no API call)
- GET `{endpoint}/api/boards/{board_id}/tasks?status=open`
- If response includes `next_cursor` or `next_url`: follow until exhausted
- Map each task to QuestWorks shape via `normalizeTask()`:
  - `externalId`: task `id` (string)
  - `externalUrl`: `{endpoint}/boards/{board_id}/tasks/{id}` (constructed)
  - `title`: task `title`
  - `description`: task `description` (trim to 4000 chars)
  - `labels`: task `tags` or `labels` array (whichever field Beads uses; handle both gracefully, prefer `tags`)
  - `priority`: task `priority` if numeric, else 0
  - `metadata`: `{ beads_board_id: board_id, beads_task_id: id }`
- On HTTP error: throw `AdapterError`
- On rate limit (429): defer to shared utils single-retry behavior

### `claim(task)`

- PATCH `{endpoint}/api/tasks/{task.external_id}` with `{ "status": "claimed", "assignee": task.assignee }`
- Returns `true` on 200; throws `AdapterError` on failure
- If Beads returns 409 (already claimed by another): log and return `false` — do not throw
- Fire-and-forget errors caught at call site; log but do not surface as task operation failure

### `update(task, changes)`

- If `changes.status` present: include in PATCH body as `{ "status": changes.status }`
- If `changes.comment` present: include in PATCH body as `{ "comment": changes.comment }`
- If both present: single PATCH with both fields
- Returns on 200; throws `AdapterError` on failure
- Fire-and-forget: same as `claim()`

### `close(task)`

- PATCH `{endpoint}/api/tasks/{task.external_id}` with `{ "status": "done" }`
- On 404 (task already gone/closed): log and return — not an error
- Throws `AdapterError` on other failures

### `health()`

- If `endpoint` or `token` missing: return `{ ok: false, message: 'missing endpoint or token' }`
- GET `{endpoint}/api/health` with bearer auth
- On 200: return `{ ok: true, message: 'Beads API reachable at {endpoint}' }`
- On 401: return `{ ok: false, message: 'token invalid or rejected' }`
- On any other error (network, 5xx, timeout): return `{ ok: false, message: error.message }`
- Must not throw

---

## Task Mapping

```
Beads Task → QuestWorks Task
──────────────────────────────────────────────
task.id (string)             → external_id
constructed URL              → external_url
task.title                   → title
task.description (max 4000)  → description
task.tags or task.labels     → labels[]
"beads"                      → source type
this.id                      → source (adapter id)
task.priority (int) or 0     → priority
{ beads_board_id, beads_task_id } → metadata
```

---

## Acceptance Criteria

- [ ] `pull()` returns `[]` and makes no API call when config is incomplete
- [ ] `pull()` returns normalized tasks for all open tasks on the board
- [ ] `pull()` follows pagination if `next_cursor` or `next_url` is present
- [ ] `pull()` maps all fields correctly including labels/tags and metadata
- [ ] `pull()` trims description to 4000 characters
- [ ] `claim()` sends correct PATCH body with status and assignee
- [ ] `claim()` returns `false` (not throw) on 409
- [ ] `update()` sends single PATCH when both status and comment provided
- [ ] `close()` patches status to `"done"`
- [ ] `close()` does not error when task returns 404 (already gone)
- [ ] `health()` returns `{ ok: false }` when config is incomplete
- [ ] `health()` returns `{ ok: true }` with endpoint info when API reachable
- [ ] `health()` returns `{ ok: false }` with message on 401
- [ ] `health()` never throws
- [ ] All HTTP calls use `fetchJson()` and `bearerAuth()` from `adapters/http.mjs`
- [ ] No credentials or tokens appear in logs

---

## Error Handling

- `pull()`: throw `AdapterError` — scheduler catches and records to `adapter_state`
- `claim()`, `update()`, `close()`: catch at call site, log, do not surface as task failure
- `health()`: never throw, always return `{ ok, message }`

---

## Open Questions

1. **Pagination format**: The stub comments reference a simple cursor or `next_url`. If Beads uses a different pagination scheme (e.g., `page`/`per_page` offset), update accordingly. The implementation should document which format it handles.
2. **`tags` vs `labels` field name**: Handle both — prefer `tags` if both present. Confirm once there's access to a live Beads instance.
3. **Assignee field format**: Does Beads accept a free-text string for assignee, or a user ID? The plan assumes free-text (agent name). Confirm before implementation.

---

## Out of Scope

- Webhook/push-based updates — polling only
- Task creation from QuestWorks into Beads
- Multi-board support (single `board_id` per adapter instance)
