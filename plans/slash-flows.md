# Plan: Slash Command Flows

**Author:** Bandit  
**Status:** Implemented  
**Scope:** `/qw` slash command flows — current state, gaps, and test requirements

---

## Overview

All slash command flows are implemented inline in `slack/flows/index.mjs`.
The command router in `slack/slash.mjs` maps commands via `COMMAND_MAP` (defined in `slack/api.mjs`).

**All 15 commands in `COMMAND_MAP` have corresponding flow implementations in `index.mjs`.**

---

## Implemented Flows (all in `slack/flows/index.mjs`)

| Command | Flow Key | Type | Done? |
|---|---|---|---|
| `/qw adapter add github` | `adapter_add_github` | Modal | ✅ |
| `/qw adapter add beads` | `adapter_add_beads` | Modal | ✅ |
| `/qw adapter add jira` | `adapter_add_jira` | Modal | ✅ |
| `/qw adapter list` | `adapter_list` | Immediate | ✅ |
| `/qw adapter remove` | `adapter_remove` | Multi-step | ✅ |
| `/qw adapter sync` | `adapter_sync` | Multi-step | ✅ |
| `/qw task list` | `task_list` | Immediate | ✅ |
| `/qw task claim` | `task_claim` | Multi-step | ✅ |
| `/qw task done` | `task_done` | Multi-step | ✅ |
| `/qw task block` | `task_block` | Multi-step | ✅ |
| `/qw task add` | `task_add` | Multi-step | ✅ |
| `/qw config set channel` | `config_set_channel` | Multi-step | ✅ |
| `/qw config set sync-interval` | `config_set_sync_interval` | Multi-step | ✅ |
| `/qw config show` | `config_show` | Immediate | ✅ |
| `/qw help` | `help` | Immediate | ✅ |

---

## Architecture Notes

### Flow Contract

Every flow exports:
- `start(db, userId, channelId, args)` → `{ message, done }` or `{ modal: true, done: true, modalDef }`
- `step(db, conv, userText)` → `{ message, done, step?, data? }`

When `done: true`, no conversation record is kept.  
When `done: false`, conversation state is persisted to the `conversations` table with a 5-minute TTL.

Modal flows return `{ modal: true, done: true, modalDef }` from `start()`. The slash router opens
the modal via `slack/api.mjs:openSlackModal()`. Submissions are handled at `POST /slash/interactions`
(HTTP) or via the `interactive` Socket Mode envelope.

### Conversation Lifecycle

1. User sends `/qw <command>` → Socket Mode or `POST /slash`
2. Router calls `flow.start()`, stores conversation if `done: false`, acknowledges Slack immediately
3. Bot posts response to channel via `chat.postMessage`
4. Subsequent user messages → Socket Mode event or `POST /slack/events` → `handleConversationReply()` → `flow.step()`
5. When `done: true`, conversation deleted from DB

### Token Security

Tokens collected during multi-step flows (adapter add) are encrypted at rest using
`db/crypto.mjs` (AES-256-GCM, key from `QW_ENCRYPTION_KEY` env var or a
generated `.qw_key` file). They are masked in display output via `maskToken()`.

### Modal Submission Extraction

Slack modal submissions arrive with `view.state.values` in the structure:
```json
{ "block_id": { "action_id": { "type": "plain_text_input", "value": "..." } } }
```

`handleModalSubmit()` in `slack/flows/index.mjs` flattens this to:
```json
{ "block_id": "value" }
```
using the convention `action_id: 'input'` on all input blocks. It then delegates to
`handleDialogSubmit()` which validates, encrypts, and stores the adapter config.

---

## Requirements

### R1 — Command Parsing
- All 15 commands in `COMMAND_MAP` must be parseable
- Longest-match parsing must be respected (e.g. `adapter add github` before `adapter add`)
- Unknown commands must return a helpful error directing user to `/qw help`

### R2 — Conversation State
- State must persist between slash invocation and Slack message replies
- TTL of 5 minutes must be enforced — expired conversations must be silently dropped
- Starting a new flow while one is active must cancel the existing conversation (fresh start)

### R3 — Input Validation
- Each multi-step flow must validate user input at each step
- Invalid input must re-prompt with a clear error message (not terminate the conversation)
- `cancel` must be accepted wherever freeform input is expected

### R4 — Token Handling
- Tokens collected in flows must be encrypted before storage
- Tokens must never appear in plain text in DB, logs, or response messages
- Display of tokens must use masked format (last 4 chars only)

### R5 — task_add External Sources
- GitHub flow: must accept both `owner/repo#number` and full GitHub issue URL formats
- Jira flow: must accept both `PROJECT-123` key format and full Jira browse URL
- Beads flow: must accept both bare task ID and full Beads URL
- All three must handle missing/unconfigured adapter gracefully
- All three must handle API errors (network failure, 4xx, 5xx) gracefully
- Duplicate imports (same `source + external_id`) must return a friendly message, not crash

### R6 — adapter_list / config_show Display
- Must mask token values in output
- Empty state (no adapters / no config) must show a friendly message, not crash

---

## Acceptance Criteria

### AC-1: Happy Path — Immediate Flows
- [ ] `/qw help` returns the full command listing
- [ ] `/qw task list` returns open tasks (or "No tasks" if empty)
- [ ] `/qw adapter list` returns adapter list (or "No adapters" if empty)
- [ ] `/qw config show` returns config (or "No configuration" if empty)

### AC-2: Happy Path — Multi-step Flows
- [ ] `/qw adapter add github` opens Block Kit modal with 4 fields
- [ ] `/qw adapter add jira` opens Block Kit modal with 5 fields
- [ ] `/qw adapter add beads` opens Block Kit modal with 4 fields
- [ ] Modal submission creates adapter, starts scheduler, triggers background sync
- [ ] `/qw adapter remove` lists adapters, accepts valid ID, requires yes/no confirmation
- [ ] `/qw adapter sync` accepts adapter ID or `all`
- [ ] `/qw task claim` shows open tasks, claims selected task atomically
- [ ] `/qw task done` shows user's tasks, marks selected task done, accepts optional note
- [ ] `/qw task block` shows user's tasks, marks selected task blocked, requires reason
- [ ] `/qw task add` → manual path: collects title, description, priority, creates task
- [ ] `/qw task add` → github path: accepts `owner/repo#number`, imports from GitHub API
- [ ] `/qw task add` → jira path: accepts `PROJECT-123`, imports from Jira API
- [ ] `/qw task add` → beads path: accepts task ID, imports from Beads API
- [ ] `/qw config set channel` updates `slack_channel` config
- [ ] `/qw config set sync-interval` validates ≥10, updates `sync_interval_seconds` config

### AC-3: Error Handling
- [ ] Invalid input at any step re-prompts (doesn't terminate conversation)
- [ ] `cancel` at any freeform step terminates cleanly
- [ ] TTL expiry drops conversation silently
- [ ] New `/qw` command while conversation active cancels old conversation
- [ ] Unknown command returns "Try `/qw help`" message
- [ ] `task claim` on a task just claimed by someone else returns a friendly message
- [ ] `task add` with duplicate external ID returns friendly message
- [ ] `task add` with GitHub/Jira/Beads API failure returns error message (not crash)
- [ ] `adapter add *` with missing adapter type returns guidance

### AC-4: Security
- [ ] Tokens collected in flows are never stored in plaintext in the `conversations.data` field
- [ ] Tokens are never logged to console
- [ ] `adapter list` masks tokens in output
- [ ] `config show` masks keys containing "token" or "secret"

---

## Test Plan

Tests live in `tests/slack/slash-flows.test.mjs`.

### Suites covered

| Suite | What it tests |
|-------|--------------|
| T1 | `parseCommand` — all 15 commands, unknown input, empty string |
| T2 | Immediate flows — help, task_list, adapter_list, config_show |
| T3 | `adapter_add_github` — `modal: true`, Block Kit structure, no `dialog` key |
| T4 | Token masking (`maskToken`) |
| T5 | `task_claim` race condition |
| T6 | `task_add` manual flow |
| T7 | `task_add` GitHub import (fetch mocked) |
| T8 | Conversation TTL enforcement |
| T9 | Fresh slash command cancels old conversation |
| T10 | `config_set_channel` stores `slack_channel`, not `mm_channel` |
| T11 | `config_set_sync_interval` |
| T12 | `adapter_remove` |
| T13 | `task_done` |
| T14 | `task_block` |
| T15 | `adapter_list` token masking |
| T16 | `handleModalSubmit` — extracts flat values from nested `view.state.values` |
| T17 | `adapter_add_jira` — Block Kit modal structure |

---

## Files Affected

- `slack/flows/index.mjs` — all flows (authoritative)
- `slack/slash.mjs` — command router and conversation engine
- `slack/api.mjs` — `COMMAND_MAP`, `parseCommand`, shared Slack helpers
- `slack/socket.mjs` — Socket Mode client (routes slash/interactive/event envelopes)
- `slack/events.mjs` — Events API HTTP router
- `tests/slack/slash-flows.test.mjs` — unit tests (implemented)
