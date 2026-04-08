# Plan: Test Suite Setup

**Author:** Jonny Quest  
**Status:** Draft — pending review by @race  

---

## Overview

QuestWorks has zero test coverage. This plan sets up the test infrastructure and defines test plans for the highest-risk areas. The goal is a practical suite that catches real bugs — not coverage theater.

---

## Test Framework Choice

**Recommendation: [Vitest](https://vitest.dev/)**

- Zero-config for ESM modules (QuestWorks uses `.mjs` throughout)
- Built-in coverage via `@vitest/coverage-v8`
- Fast, no Babel/transform needed
- Compatible with Node 18+

**Dependencies to add:**
```json
"devDependencies": {
  "vitest": "^1.x",
  "@vitest/coverage-v8": "^1.x",
  "better-sqlite3": "(already in prod deps)"
}
```

**Scripts to add to `package.json`:**
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

**Config (`vitest.config.js`):**
```js
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    coverage: { reporter: ['text', 'lcov'] }
  }
});
```

Tests live in `tests/`. Files named `*.test.mjs`.

---

## Test Areas and Plans

### 1. Atomic Claim Logic (HIGH PRIORITY)

File: `tests/routes/tasks-claim.test.mjs`

The claim endpoint uses a SQLite transaction to prevent double-claiming. This is the most critical correctness guarantee in the system.

**Test cases:**
- Claim an open task → returns 200 with `status: "claimed"` and `assignee` set
- Claim an already-claimed task → returns 409 with `{ error: "already claimed" }`
- Claim a non-existent task → returns 404
- Concurrent claims: simulate two simultaneous claim requests for the same task — only one should succeed, the other gets 409
- Claim creates a `task_history` record with `action: "claim"`
- Unclaim returns task to `open` status with `assignee: null`

**Test setup:** Use in-memory SQLite (`":memory:"`), run schema migrations, insert test task directly.

### 2. Task Status Transitions

File: `tests/routes/tasks-status.test.mjs`

**Test cases:**
- Valid status values (`open`, `claimed`, `in_progress`, `review`, `done`, `blocked`) all accepted
- Invalid status value returns 400
- Missing status returns 400
- Status update creates history record
- `complete` endpoint sets status to `done` and calls `adapter.close()` (mock adapter)
- `complete` endpoint still succeeds if adapter.close() throws

### 3. Task CRUD

File: `tests/routes/tasks-crud.test.mjs`

**Test cases:**
- `GET /tasks` returns all tasks
- `GET /tasks?status=open` filters correctly
- `GET /tasks?assignee=agent1` filters correctly
- `GET /tasks/:id` returns single task
- `GET /tasks/:id` with unknown id returns 404
- `GET /tasks/:id/history` returns history array
- `POST /tasks/:id/comment` adds history record

### 4. Auth Middleware

File: `tests/auth.test.mjs`

**Test cases:**
- When `QUESTWORKS_TOKEN` not set: all endpoints accessible without auth header
- When token set: requests without `Authorization` header return 401
- When token set: requests with wrong token return 401
- When token set: requests with correct `Authorization: Bearer <token>` succeed
- `GET /health` is always accessible regardless of token setting
- `POST /slash` is always accessible regardless of token setting (webhook must not require auth)

### 5. Adapter Upsert / Sync Behavior

File: `tests/sync/scheduler.test.mjs`

The scheduler calls `adapter.pull()` and upserts results using `UNIQUE(source, external_id)`. This is the conflict-resolution path.

**Test cases:**
- New task from adapter is inserted into DB
- Existing task (same source + external_id) is updated, not duplicated
- `adapter_state` record is updated after successful sync
- `adapter_state.last_error` is populated when adapter throws
- Scheduler skips failed adapters and continues to next
- `pull()` returning empty array doesn't delete existing tasks

### 6. HTTP Utility Layer (once `adapters/http.mjs` is implemented)

File: `tests/adapters/http.test.mjs`

**Test cases:**
- `fetchJson()` returns parsed JSON on 200
- `fetchJson()` throws `AdapterError` on 4xx
- `fetchJson()` throws `AdapterError` on 5xx
- `fetchJson()` retries once on 429 and succeeds on retry
- `fetchJson()` throws after retry if second attempt also 429
- `bearerAuth()` returns correct `Authorization` header
- `basicAuth()` returns base64-encoded `Authorization` header

Use `globalThis.fetch` mock (Vitest built-in `vi.stubGlobal`).

### 7. GitHub Adapter (once implemented)

File: `tests/adapters/github.test.mjs`

**Test cases:**
- `pull()` with no `label_filter` returns `[]` without making API call
- `pull()` maps issue fields to correct QuestWorks task shape
- `pull()` follows pagination (test with mocked 2-page response)
- `pull()` trims description to 4000 chars
- `claim()` posts comment containing assignee name
- `update()` with comment and status posts single combined comment
- `close()` patches state to closed and posts completion comment
- `close()` does not throw when issue returns 404 (already closed)
- `health()` returns ok:false when no token
- `health()` returns ok:true with rate limit info on success
- `health()` returns ok:false on 401
- `health()` never throws

Mock `adapters/http.mjs` module.

### 8. Slash Command Parser

File: `tests/slack/slash-flows.test.mjs` (implemented — see `slash-flows.md` for full test matrix)

**Test cases:**
- `/qw task list` routes to `task_list` flow
- `/qw task add` routes to `task_add` flow
- `/qw adapter list` routes to `adapter_list` flow
- `/qw help` routes to `help` flow
- Unknown command returns error response
- Empty body returns usage message
- Command is case-insensitive

---

## Test Utilities / Fixtures

**`tests/helpers/db.mjs`**
```js
// Returns a fresh in-memory db with schema applied — use in beforeEach
export function makeTestDb() { ... }
```

**`tests/helpers/tasks.mjs`**
```js
// Insert a test task directly, returns task object
export function insertTask(db, overrides = {}) { ... }
```

**`tests/helpers/app.mjs`**
```js
// Spin up Express app with test db and mock notifier/adapters
export function makeTestApp(db, { adapters, notifier } = {}) { ... }
```

---

## Acceptance Criteria

- [ ] `npm test` runs the full suite and exits 0 on a clean state
- [ ] `npm test` exits non-zero when any test fails
- [ ] All claim logic tests pass including concurrent claim simulation
- [ ] All auth middleware tests pass
- [ ] Test helpers make it easy to add new tests without boilerplate
- [ ] No test connects to a real database, real GitHub, or real Mattermost
- [ ] Tests run in under 10 seconds total
- [ ] Coverage report generated by `npm run test:coverage`

---

## Out of Scope (this plan)

- E2E tests against a live server
- Load/performance tests
- Jira, Beads adapter tests (covered by their respective plans)
- Slash flow tests beyond the parser (covered by slash-flows plan)
