# Plan: Adapter Shared Utilities

**Author:** Dr. Quest  
**Status:** Draft — pending Race review  
**Affects:** All external adapter implementations (GitHub, Jira, Beads)

---

## Problem

All three external adapters (GitHub, Jira, Beads) need to make authenticated HTTP requests and handle errors consistently. Without a shared utility, each adapter will invent its own fetch wrapper, error handling, and retry logic — resulting in three divergent implementations that are harder to test and maintain.

## Proposed Solution

Create `adapters/http.mjs` — a thin shared HTTP utility used by all adapter implementations.

---

## Requirements

### R1 — `fetchJson(url, options)` helper
- Wraps `fetch()` with consistent error handling
- Accepts standard `RequestInit` options (headers, method, body, etc.)
- On non-2xx response: throws an `AdapterError` with `{ status, message, body }`
- On network error: throws an `AdapterError` wrapping the original error
- Returns parsed JSON body on success

### R2 — `AdapterError` class
- Extends `Error`
- Properties: `status` (HTTP status or `0` for network errors), `message`, `body` (raw response text or null)
- Used by all adapters to signal retrievable vs. fatal errors

### R3 — Auth header factories
- `bearerAuth(token)` → `{ Authorization: 'Bearer <token>' }`
- `basicAuth(user, token)` → `{ Authorization: 'Basic <base64>' }` (for Jira)
- Returns plain objects to be spread into `headers`

### R4 — Retry behavior
- Single retry on 429 (Too Many Requests) with `Retry-After` header respect (up to 60s)
- No retry on 4xx (except 429) or 5xx — surface error immediately
- No retry on network errors — surface immediately (scheduler will retry on next cycle)

### R5 — No global state
- No module-level singletons or shared connection pools
- Each call is independent

---

## Interface

```js
// adapters/http.mjs

export class AdapterError extends Error {
  constructor(message, status = 0, body = null) { ... }
}

export function bearerAuth(token) { ... }
export function basicAuth(user, token) { ... }

/**
 * @param {string} url
 * @param {RequestInit & { retryOn429?: boolean }} options
 * @returns {Promise<any>} parsed JSON
 * @throws {AdapterError}
 */
export async function fetchJson(url, options = {}) { ... }
```

---

## Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC1 | `fetchJson` returns parsed JSON for 200–299 responses |
| AC2 | `fetchJson` throws `AdapterError` with correct `status` on 4xx/5xx |
| AC3 | `fetchJson` throws `AdapterError` with `status=0` on network error |
| AC4 | `fetchJson` retries once on 429, respecting `Retry-After` up to 60s |
| AC5 | `fetchJson` does NOT retry on 4xx (except 429) or 5xx |
| AC6 | `bearerAuth` returns correct `Authorization` header object |
| AC7 | `basicAuth` returns correct Base64-encoded `Authorization` header object |
| AC8 | Module has no side effects on import |
| AC9 | All adapter implementations import from `./http.mjs` — no adapter invents its own fetch wrapper |

---

## Test Plan

File: `tests/adapters/http.test.mjs`

Tests use a mock `fetch` (injected or patched via the test framework's globals).

| Test | Description |
|------|-------------|
| T1 | 200 response → returns parsed JSON |
| T2 | 404 response → throws `AdapterError` with `status=404` |
| T3 | 500 response → throws `AdapterError` with `status=500` |
| T4 | Network error → throws `AdapterError` with `status=0` |
| T5 | 429 with `Retry-After: 1` → retries once, returns parsed JSON on second call |
| T6 | 429 with `Retry-After: 120` (> 60s) → does NOT retry, throws `AdapterError` |
| T7 | 429 with no `Retry-After` header → retries once after 1s default |
| T8 | `bearerAuth('tok')` → `{ Authorization: 'Bearer tok' }` |
| T9 | `basicAuth('user', 'pass')` → correct Base64 `Basic` header |
| T10 | Two calls do not share state |

---

## Notes for Adapter Authors

- Import only `fetchJson`, `bearerAuth`/`basicAuth`, and `AdapterError` from `./http.mjs`
- Catch `AdapterError` in adapter methods and log with the adapter's `[type:id]` prefix before re-throwing or returning gracefully
- The `health()` method should catch errors and return `{ ok: false, message: err.message }` — never throw

---

## Dependencies

- None beyond Node.js built-in `fetch` (available in Node 18+)
- Test framework: to be determined in `plans/test-suite.md` (Jonny's plan)
