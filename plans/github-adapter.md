# Plan: GitHub Issues Adapter

**Author:** Jonny Quest  
**Status:** Draft — pending review by @race  
**Depends on:** `plans/adapter-shared-utils.md` (use `AdapterError`, `bearerAuth()`, `fetchJson()` from `adapters/http.mjs`)

---

## Overview

Implement the `GitHubAdapter` class in `adapters/github.mjs` to bridge GitHub Issues with QuestWorks. The adapter pulls labeled issues, posts comments on claim/update, and closes issues on completion.

---

## GitHub API Reference

All requests to `https://api.github.com`. Auth via `Authorization: Bearer <token>` (use `bearerAuth()` from shared utils).

| Operation | Method | Path |
|---|---|---|
| List issues | GET | `/repos/{repo}/issues?labels={label}&state=open&per_page=100` |
| Get issue | GET | `/repos/{repo}/issues/{number}` |
| Post comment | POST | `/repos/{repo}/issues/{number}/comments` |
| Close issue | PATCH | `/repos/{repo}/issues/{number}` body: `{ state: "closed" }` |
| Rate limit check | GET | `/rate_limit` |

Pagination: GitHub returns `Link` header with `rel="next"`. The adapter must follow pages until no next link.

---

## Configuration

Config fields (from `config.yaml`, env-expanded):

| Field | Required | Description |
|---|---|---|
| `repo` | Yes | `owner/repo` string |
| `token` | Yes | GitHub PAT with `repo` scope (or fine-grained with issues read/write) |
| `label_filter` | Yes | Comma-separated label(s) — skip sync if absent |

If `label_filter` is absent, `pull()` logs and returns `[]` (existing behavior — keep it).

---

## Method Requirements

### `pull()`

- If `label_filter` not set: log and return `[]`
- Build URL: `GET /repos/{repo}/issues?labels={label_filter}&state=open&per_page=100`
- Follow pagination via `Link` header until no `next` rel
- Map each issue to QuestWorks task shape via `normalizeTask()`:
  - `externalId`: issue `number` as string
  - `externalUrl`: issue `html_url`
  - `title`: issue `title`
  - `description`: issue `body` (trim to 4000 chars; markdown preserved)
  - `labels`: issue `labels[].name`
  - `priority`: 0 (no mapping from GitHub)
  - `metadata`: `{ github_number: number, github_node_id: node_id }`
- On HTTP error: throw `AdapterError`
- On rate limit (429): defer to shared utils single-retry behavior

### `claim(task)`

- POST comment to issue: `"🔬 Claimed by {task.assignee}"`
- Returns `true` on 201; throws `AdapterError` on failure
- Fire-and-forget errors should be caught and logged (not re-thrown) — claiming in QuestWorks is already committed

### `update(task, changes)`

- If `changes.comment` present: POST comment to issue with the comment text
- If `changes.status` present and no comment: POST a brief status note: `"Status → {changes.status}"`
- If both: combine into one comment
- Throws `AdapterError` on failure (same fire-and-forget guidance as `claim`)

### `close(task)`

- PATCH issue to `state: "closed"`
- POST comment: `"✅ Completed by {task.assignee || 'agent'}"`
- On 404 (issue already closed): log and return (not an error)
- Throws `AdapterError` on other failures

### `health()`

- If no token: return `{ ok: false, message: 'no token configured' }`
- GET `/rate_limit` with auth
- On 200: return `{ ok: true, message: 'GitHub API reachable, {remaining}/{limit} requests remaining' }`
- On 401: return `{ ok: false, message: 'token invalid or expired' }`
- On any other error: return `{ ok: false, message: error.message }`
- Must not throw

---

## Task Mapping

```
GitHub Issue → QuestWorks Task
─────────────────────────────────────────────────
issue.number (string) → external_id
issue.html_url        → external_url
issue.title           → title
issue.body            → description (max 4000 chars)
issue.labels[].name   → labels[]
"github"              → source
adapter id            → source (use this.id)
0                     → priority
{ github_number, github_node_id } → metadata
```

---

## Acceptance Criteria

- [ ] `pull()` returns `[]` when `label_filter` not set (no API call made)
- [ ] `pull()` returns normalized tasks for all matching open issues
- [ ] `pull()` follows pagination and returns issues from all pages
- [ ] `pull()` correctly maps all fields including labels and metadata
- [ ] `claim()` posts a comment containing the assignee name
- [ ] `update()` posts a single comment when both status and comment provided
- [ ] `close()` patches issue state to closed AND posts completion comment
- [ ] `close()` does not error when issue is already closed (404 on PATCH)
- [ ] `health()` returns `{ ok: false }` when token is missing
- [ ] `health()` returns `{ ok: true }` with rate limit info when token valid
- [ ] `health()` returns `{ ok: false }` with message when token invalid (401)
- [ ] `health()` never throws
- [ ] All HTTP calls use `fetchJson()` and `bearerAuth()` from `adapters/http.mjs`
- [ ] No credentials or tokens appear in logs

---

## Error Handling

- `pull()`: throw `AdapterError` — scheduler catches and records to `adapter_state`
- `claim()`, `update()`, `close()`: catch at call site in routes/scheduler, log, do not surface to user as task operation failure
- `health()`: never throw, always return `{ ok, message }`

---

## Out of Scope

- Webhook support (push-based updates) — polling only
- Issue creation from QuestWorks
- PR support
- Assigning GitHub users (comment-based claim only)
