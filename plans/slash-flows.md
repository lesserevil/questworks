# Plan: Slash Command Flows

**Author:** Bandit  
**Status:** Draft — pending Race review  
**Scope:** `/qw` slash command flows — current state, gaps, and test requirements

---

## Overview

All slash command flows are implemented inline in `mattermost/flows/index.mjs`.
The command router in `mattermost/slash.mjs` maps commands via `COMMAND_MAP`.

**Contrary to initial analysis, no flows are missing.** All 15 commands in `COMMAND_MAP`
have corresponding flow implementations in `index.mjs`. The separate `.mjs` files in
`mattermost/flows/` (e.g. `adapter_add_github.mjs`) appear to be older/experimental
stubs and are NOT used by the current system — `index.mjs` is authoritative.

---

## Implemented Flows (all in `mattermost/flows/index.mjs`)

| Command | Flow Key | Type | Done? |
|---|---|---|---|
| `/qw adapter add github` | `adapter_add_github` | Multi-step | ✅ |
| `/qw adapter add beads` | `adapter_add_beads` | Multi-step | ✅ |
| `/qw adapter add jira` | `adapter_add_jira` | Multi-step | ✅ |
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
- `start(db, userId, channelId, args)` → `{ message, done }`
- `step(db, conv, userText)` → `{ message, done, step?, data? }`

When `done: true`, no conversation record is kept.  
When `done: false`, conversation state is persisted to the `conversations` table with a 5-minute TTL.

### Conversation Lifecycle

1. User sends `/qw <command>` → POST `/slash`
2. Router calls `flow.start()`, stores conversation, replies immediately (200 OK)
3. Bot posts response to channel via MM API
4. Subsequent user messages → WebSocket → `handleConversationReply()` → `flow.step()`
5. When `done: true`, conversation deleted from DB

### Token Security

Tokens collected during multi-step flows (adapter add) are encrypted at rest using
`mattermost/crypto.mjs` (AES-256-GCM, key from `DB_ENCRYPTION_KEY` env var or a
generated `.qw_key` file). They are masked in display output via `maskToken()`.

---

## Requirements

### R1 — Command Parsing
- All 15 commands in `COMMAND_MAP` must be parseable
- Longest-match parsing must be respected (e.g. `adapter add github` before `adapter add`)
- Unknown commands must return a helpful error directing user to `/qw help`

### R2 — Conversation State
- State must persist between slash invocation and WebSocket replies
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
- [ ] `/qw adapter add github` completes with valid repo/token/label/name inputs
- [ ] `/qw adapter add jira` completes with valid url/token/project/name inputs
- [ ] `/qw adapter add beads` completes with valid endpoint/token/board_id/name inputs
- [ ] `/qw adapter remove` lists adapters, accepts valid ID, requires yes/no confirmation
- [ ] `/qw adapter sync` accepts adapter ID or `all`
- [ ] `/qw task claim` shows open tasks, claims selected task atomically
- [ ] `/qw task done` shows user's tasks, marks selected task done, accepts optional note
- [ ] `/qw task block` shows user's tasks, marks selected task blocked, requires reason
- [ ] `/qw task add` → manual path: collects title, description, priority, creates task
- [ ] `/qw task add` → github path: accepts `owner/repo#number`, imports from GitHub API
- [ ] `/qw task add` → jira path: accepts `PROJECT-123`, imports from Jira API
- [ ] `/qw task add` → beads path: accepts task ID, imports from Beads API
- [ ] `/qw config set channel` updates mm_channel config
- [ ] `/qw config set sync-interval` validates ≥10, updates sync_interval_seconds config

### AC-3: Error Handling
- [ ] Invalid input at any step re-prompts (doesn't terminate conversation)
- [ ] `cancel` at any freeform step terminates cleanly
- [ ] TTL expiry drops conversation silently
- [ ] New `/qw` command while conversation active cancels old conversation
- [ ] Unknown command returns "Try `/qw help`" message
- [ ] `task claim` on a task just claimed by someone else returns a friendly message
- [ ] `task add` with duplicate external ID returns friendly message
- [ ] `task add` with GitHub/Jira/Beads API failure returns error message (not crash)
- [ ] `adapter add *` with missing adapter type (Jira/Beads not configured) returns guidance

### AC-4: Security
- [ ] Tokens collected in flows are never stored in plaintext in the `conversations.data` field
- [ ] Tokens are never logged to console
- [ ] `adapter list` masks tokens in output
- [ ] `config show` masks keys containing "token" or "secret"

---

## Test Plan

### Unit Tests (no server required)

**T1 — Command Parser**
```
parseCommand('adapter add github') → { flowName: 'adapter_add_github', args: '' }
parseCommand('adapter add github extra') → { flowName: 'adapter_add_github', args: 'extra' }
parseCommand('adapter add') → null  (not a valid command on its own)
parseCommand('unknown stuff') → null
parseCommand('') → null
parseCommand('help') → { flowName: 'help', args: '' }
parseCommand('task list') → { flowName: 'task_list', args: '' }
```

**T2 — Flow: adapter_add_github**
```
start() → message contains "Step 1/4"
step(step=0, 'bad-input') → re-prompts (done: false, step: 0)
step(step=0, 'owner/repo') → advances to step 1
step(step=1, 'ghp_token') → encrypts token, advances to step 2
step(step=2, 'questworks') → advances to step 3
step(step=3, '') → uses default name, inserts row, done: true
step(step=3, 'my-adapter') → uses custom name, inserts row, done: true
```

**T3 — Flow: task_claim (race condition)**
```
Setup: two in-memory DB calls claiming same task simultaneously
Result: exactly one succeeds, one gets "just claimed by someone else"
```

**T4 — Flow: task_add (manual)**
```
step(step=0, 'manual') → prompts for title
step(step=1, '') → re-prompts (empty title rejected)
step(step=1, 'My Task') → prompts for description
step(step=2, '') → prompts for priority (empty description accepted)
step(step=3, '2') → creates task, done: true
step(step=3, '5') → re-prompts (invalid priority)
```

**T5 — Flow: task_add (GitHub import)**
```
Mock GitHub API returning 200 with issue data:
  → task inserted, message contains issue title
Mock GitHub API returning 404:
  → done: true, message contains error
No token available:
  → still attempts unauthenticated request (rate-limited but functional)
Duplicate external_id:
  → done: true, message contains "already exists"
```

**T6 — TTL enforcement**
```
Create conversation with updated_at = (now - 6 minutes)
handleConversationReply() → conversation deleted, no response sent
```

**T7 — Fresh start on new command**
```
Create active conversation for user+channel
Trigger new /qw command for same user+channel
Old conversation deleted, new flow starts
```

**T8 — Token masking**
```
maskToken('ghp_abcdefgh1234') → '...1234'
maskToken('ab') → '****'
maskToken('') → '****'
maskToken(null) → '****'
```

### Integration Tests (requires running server + DB)

**T9 — End-to-end slash flow via HTTP**
```
POST /slash with text='help' → 200 OK, bot posts help message to channel
POST /slash with text='task list' → 200 OK, bot posts task list
POST /slash with text='unknown command' → 200 OK, bot posts error
```

**T10 — Multi-step flow via WebSocket simulation**
```
POST /slash text='adapter add github' → conversation created
Simulate WS reply 'owner/repo' → conversation advances
Simulate WS reply 'token' → conversation advances
Simulate WS reply 'label' → conversation advances
Simulate WS reply '' → conversation done, adapter row exists in DB
```

---

## Open Questions

1. **Separate flow files vs. index.mjs**: The `mattermost/flows/` directory contains stub
   `.mjs` files (`adapter_add_github.mjs`, etc.) that are NOT imported by anything. Should
   these be deleted to avoid confusion, or kept for reference? Recommend deletion.

2. **`task_add` for external sources**: The `_addGithub`, `_addJira`, `_addBeads` helper
   functions use inline `fetch()` calls rather than a shared HTTP utility. Once @drquest's
   `adapter-shared-utils.md` is published, these should be refactored to use the shared helper.

3. **Conversation TTL**: Currently 5 minutes (hardcoded). Should this be configurable?

4. **`task list` default filter**: Currently shows only `open` tasks, limited to 20.
   Should agents be able to filter by status, source, or assignee from the slash command?

---

## Files Affected

- `mattermost/flows/index.mjs` — all flows (authoritative)
- `mattermost/slash.mjs` — command router and conversation engine
- `mattermost/flows/adapter_add_github.mjs` — stub, not used (recommend delete)
- `mattermost/flows/adapter_add_jira.mjs` — stub, not used (recommend delete)
- `mattermost/flows/adapter_add_beads.mjs` — stub, not used (recommend delete)
- `mattermost/flows/adapter_github.mjs` — stub, not used (recommend delete)
- `mattermost/flows/adapter_jira.mjs` — stub, not used (recommend delete)
- `mattermost/flows/adapter_beads.mjs` — stub, not used (recommend delete)
- `mattermost/flows/config.mjs` — stub, not used (recommend delete)
- `mattermost/flows/adapter_remove.mjs` — stub, not used (recommend delete)
- `mattermost/flows/task_block.mjs` — stub, not used (recommend delete)
- `mattermost/flows/task_claim.mjs` — stub, not used (recommend delete)
- `mattermost/flows/task_done.mjs` — stub, not used (recommend delete)

New file to create:
- `tests/slash-flows.test.mjs` — unit + integration tests per this plan
