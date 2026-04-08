# Slack Notifier Thread Tracking Plan

**Author:** Hadji  
**Status:** Implemented  

---

## Problem

`SlackNotifier.onNewTask()` creates a new post and returns the Slack message timestamp (`ts`), but nothing stores that timestamp back to the task. As a result, `onClaimed()` and `onCompleted()` cannot post as replies in the same thread — they create new standalone posts. This breaks the expected UX of a single thread per task.

---

## Requirements

### R1 — Store message timestamp on new task notification
When `onNewTask(task)` succeeds and returns a Slack `ts`, that value must be persisted to the task's `metadata` field as `metadata.slack_ts`.

### R2 — Reply in-thread on claim and completion
`onClaimed(task)` and `onCompleted(task)` must check for `task.metadata.slack_ts`. If present, post the notification as a thread reply (`thread_ts: slack_ts`). If absent, fall back to a standalone post (current behavior).

### R3 — No change to the notifier's public interface
The `onNewTask(task)`, `onClaimed(task)`, `onCompleted(task)` signatures do not change. The timestamp storage is handled inside the sync scheduler, not by the notifier itself.

### R4 — Metadata update is non-blocking
Storing the `ts` back to the task must not delay the HTTP response. It runs after the response is sent.

---

## Design

### Where the timestamp gets stored
`sync/scheduler.mjs` calls `notifier.onNewTask()` after upsert. The return value is currently discarded. The fix:

```js
// In sync/scheduler.mjs, after upsert:
const ts = await notifier.onNewTask(task);
if (ts) {
  const meta = JSON.parse(task.metadata || '{}');
  meta.slack_ts = ts;
  db.prepare('UPDATE tasks SET metadata=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(meta), new Date().toISOString(), task.id);
}
```

### Where claim/complete notifications change
In `SlackNotifier`, `onClaimed` and `onCompleted` use `thread_ts` when available:

```js
async onClaimed(task) {
  if (!this.enabled) return;
  const ts = task.metadata?.slack_ts;
  await this._post('/chat.postMessage', {
    channel: await this._getChannelId(),
    ...(ts ? { thread_ts: ts } : {}),
    text: `*${task.title}* claimed by ${task.assignee}`,
  });
}
```

Same pattern for `onCompleted`.

### Deserialization
`routes/tasks.mjs` already has a `deserializeTask()` helper that parses `metadata` from JSON string to object. The notifier receives deserialized tasks, so `task.metadata.slack_ts` is accessible without extra parsing.

---

## Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC1 | When a new task notification is posted and Slack returns `{ ok: true, ts: '...' }`, `metadata.slack_ts` is saved to the task in the database |
| AC2 | `onClaimed()` posts as a thread reply (`thread_ts` set) when `slack_ts` is present in task metadata |
| AC3 | `onCompleted()` posts as a thread reply when `slack_ts` is present |
| AC4 | Both methods fall back to standalone posts when `slack_ts` is absent |
| AC5 | Metadata write failure does not crash the scheduler or affect task state |
| AC6 | Timestamp storage does not add latency to sync operations (fire-and-forget update) |

---

## Test Plan

Tests live in `tests/slack/notify.test.mjs`.

| Test | Description |
|------|-------------|
| T1 | `onNewTask()` returns `ts` when Slack API responds with `{ ok: true, ts: '...' }` |
| T2 | `onNewTask()` returns undefined when Slack API fails — no crash |
| T3 | `onNewTask()` returns undefined when API returns `ok: false` — no crash |
| T4 | Scheduler stores `slack_ts` in task metadata after successful `onNewTask()` |
| T5 | Scheduler skips metadata write when `onNewTask()` returns falsy |
| T6 | `onClaimed()` includes `thread_ts` in post body when task has `slack_ts` |
| T7 | `onClaimed()` omits `thread_ts` when task has no `slack_ts` |
| T8 | `onCompleted()` includes `thread_ts` when task has `slack_ts` |
| T9 | `onCompleted()` omits `thread_ts` when no `slack_ts` |
| T10 | Disabled notifier (no token) does nothing, returns undefined |
| T11 | Metadata DB write happens after notify (verify order) |
| T12 | `onNewTask()` posts to `/chat.postMessage` with correct channel ID |

---

## Affected Files

- `sync/scheduler.mjs` — capture and store `ts` after `onNewTask()`
- `slack/notify.mjs` — add `thread_ts` to claim/complete posts
- `tests/slack/notify.test.mjs` — test file (implemented)

No schema changes required. `metadata` is already a JSON text column.

---

## Open Questions

1. **What if a task is notified more than once?** The current `onNewTask()` is called on every upsert in the scheduler. If a task already has `slack_ts`, the scheduler should skip calling `onNewTask()` again to avoid duplicate posts. Add a check: `if (!task.metadata?.slack_ts) { ... notify ... }`.

2. **Thread vs. channel for claim/complete posts**: Current design assumes the same channel (via `_getChannelId()`). If tasks can notify to different channels, the channel ID should also be stored in metadata.
