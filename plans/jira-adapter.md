# Jira Adapter Implementation Plan

**Author:** Hadji  
**Status:** Draft — pending Race security review  

---

## Overview

Implement `adapters/jira.mjs` to replace the current stub. The adapter connects QuestWorks to a Jira Cloud or Jira Server instance, pulling issues as tasks, reflecting claim/status/close back to Jira via the Jira REST API v3.

All HTTP calls use `adapters/http.mjs` (`fetchJson`, `AdapterError`) per the shared utils plan. Auth uses `basicAuth()` (email:token for Jira Cloud, username:password for Server).

---

## Configuration

```yaml
adapters:
  - id: jira-quest
    type: jira
    config:
      url: $JIRA_URL            # e.g. https://company.atlassian.net
      email: $JIRA_EMAIL        # Jira Cloud: user email
      token: $JIRA_TOKEN        # Jira Cloud: API token; Server: password
      project: QUEST            # project key
      jql: ""                   # optional extra JQL filter
      in_progress_transition: "In Progress"   # transition name to use on claim
      done_transition: "Done"                 # transition name to use on close
```

No credentials are stored in the repo. All `$VAR` references are expanded from environment variables at startup, consistent with the existing config pattern.

---

## Requirements

### R1 — `pull()`
- Query Jira for open issues in the configured project using JQL:
  `project={project} AND statusCategory != Done ORDER BY created ASC`
  plus any optional `jql` config override appended with `AND`.
- Paginate using `startAt` / `maxResults` (default 50 per page) until all results fetched.
- Map each issue to QuestWorks task shape using `normalizeTask()`:
  - `externalId` → Jira issue key (e.g. `QUEST-42`)
  - `externalUrl` → `{url}/browse/{key}`
  - `title` → `fields.summary`
  - `description` → `fields.description.content` (ADF plain text extract) or plain string
  - `labels` → `fields.labels`
  - `priority` → mapped from Jira priority name: Highest=4, High=3, Medium=2, Low=1, Lowest=0
  - `metadata` → `{ jira_status: fields.status.name, issue_type: fields.issuetype.name }`
- Return empty array on connection errors (log, do not throw).

### R2 — `claim(task)`
- Assign the issue to the configured service account: `PUT /rest/api/3/issue/{key}/assignee`
- Transition the issue to the `in_progress_transition` status using the transition ID looked up via `GET /rest/api/3/issue/{key}/transitions`.
- Cache the transition ID map per-session to avoid repeated lookups.
- Return `true` on success, `false` on error (log error, do not throw).

### R3 — `update(task, changes)`
- If `changes.comment` present: `POST /rest/api/3/issue/{key}/comment` with ADF body wrapping the plain text.
- If `changes.status` present and not `done`: no Jira transition (status tracking is QuestWorks-internal unless it maps to a known transition).
- Fire-and-forget errors (log, do not throw).

### R4 — `close(task)`
- Transition the issue to the `done_transition` status.
- Log on error, do not throw.

### R5 — `health()`
- `GET /rest/api/3/myself` to verify credentials and connectivity.
- Return `{ ok: true, message: 'authenticated as {displayName}' }` on success.
- Return `{ ok: false, message: error }` on failure.

---

## Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC1 | `pull()` returns a non-empty array of normalized tasks when Jira has open issues in the project |
| AC2 | `pull()` returns an empty array and logs an error when Jira is unreachable — does not throw |
| AC3 | `pull()` paginates correctly and returns all issues when there are more than 50 |
| AC4 | `claim()` assigns the issue and transitions it to In Progress; returns `true` |
| AC5 | `claim()` returns `false` and logs when the transition or assignment fails |
| AC6 | `update()` posts a comment to the Jira issue when `changes.comment` is provided |
| AC7 | `close()` transitions the issue to Done |
| AC8 | `health()` returns `ok: true` with the authenticated user's display name |
| AC9 | `health()` returns `ok: false` with an error message when credentials are invalid |
| AC10 | No credentials appear in logs or error messages |
| AC11 | All HTTP calls go through `adapters/http.mjs` — no inline `fetch()` calls |

---

## Test Plan

Tests live in `tests/adapters/jira.test.mjs`. Use a mock HTTP layer (stub `adapters/http.mjs`) — no real Jira instance required.

| Test | Description |
|------|-------------|
| T1 | `pull()` maps a single Jira issue to correct QuestWorks task shape |
| T2 | `pull()` handles empty results (zero issues) |
| T3 | `pull()` paginates: first page returns `total > maxResults`, second page fetched |
| T4 | `pull()` catches HTTP errors and returns `[]` |
| T5 | `claim()` calls assignee and transition APIs in order; returns `true` |
| T6 | `claim()` returns `false` when transition API returns 4xx |
| T7 | `update()` with comment calls issue comment API |
| T8 | `update()` with no comment makes no API calls |
| T9 | `close()` calls transition API with done transition ID |
| T10 | `health()` returns ok on 200 from `/myself` |
| T11 | `health()` returns not-ok on 401 from `/myself` |
| T12 | No credential values appear in any logged output (check log capture) |

---

## Dependencies

- `adapters/http.mjs` — shared HTTP utils (per `plans/adapter-shared-utils.md`)
- `adapters/base.mjs` — `BaseAdapter`, `normalizeTask()`
- Jira REST API v3 (Cloud) / v2 (Server — same endpoints, minor schema differences)

## Security Notes

- The Jira API token is passed via config (environment variable). It must never be logged or included in error messages.
- Token-at-rest encryption is governed by `DB_ENCRYPTION_KEY` (consistent with how slash flows handle stored adapter credentials per `plans/slash-flows.md`). The adapter config loader is responsible for decryption before passing config to the adapter constructor.

## Open Questions

1. **Jira Server vs Cloud auth**: Cloud uses email+API token (basic auth). Server uses username+password or PAT. Should the adapter support both, or Cloud-only for now?  
   → Recommend: Cloud-only first; Server support behind a `server_mode: true` config flag.

2. **ADF comment formatting**: Jira Cloud requires Atlassian Document Format for comments. A minimal ADF wrapper (plain paragraph) is sufficient — no need for full Markdown conversion.

3. **Transition name resolution**: Transition names vary by project workflow. The plan uses config-supplied names (`in_progress_transition`, `done_transition`) resolved at runtime via the transitions API. If a transition name is not found, `claim()` should log a clear error with available transition names to help admins debug.
