# Mattermost Notifier Thread Tracking Plan

**Author:** Hadji  
**Status:** Draft — pending Race security review  

---

## Problem

`MattermostNotifier.onNewTask()` creates a new post and returns the Mattermost post ID, but nothing stores that ID back to the task. As a result, `onClaimed()` and `onCompleted()` cannot post as replies in the same thread — they create new standalone posts. This breaks the expected UX of a single thread per task.

---

## Requirements

### R1 — Store post ID on new task notification
When `onNewTask(task)` succeeds and returns a Mattermost post ID, that ID must be persisted to the task's `metadata` field as `metadata.mm_post_id`.

### R2 — Reply in-thread on claim and completion
`onClaimed(task)` and `onCompleted(task)` must check for `task.metadata.mm_post_id`. If present, post the notification as a reply to that thread (`root_id: mm_post_id`). If absent, fall back to a standalone post (current behavior).

### R3 — No change to the notifier's public interface
The `onNewTask(task)`, `onClaimed(task)`, `onCompleted(task)` signatures do not change. The post ID storage is handled inside the routes/task lifecycle, not by the notifier itself.

### R4 — Metadata update is non-blocking
Storing the post ID back to the task must not delay the HTTP response. It runs after the response is sent.

---

## Design

### Where the post ID gets stored
`routes/tasks.mjs` already calls `notifier.onNewTask()` when a task arrives via the sync scheduler (via `sync/scheduler.mjs`). The return value is currently discarded. The fix:

```js
// In sync/scheduler.mjs, after upsert:
const postId = await notifier.onNewTask(task);
if (postId) {
  const meta = JSON.parse(task.metadata || '{}');
  meta.mm_post_id = postId;
  db.prepare('UPDATE tasks SET metadata=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(meta), new Date().toISOString(), task.id);
}
```

### Where claim/complete notifications change
In `MattermostNotifier`, update `onClaimed` and `onCompleted` to use `root_id` when available:

```js
async onClaimed(task) {
  if (!this.enabled) return;
  const postId = task.metadata?.mm_post_id;
  await this._post('/api/v4/posts', {
    channel_id: await this._getChannelId(),
    ...(postId ? { root_id: postId } : {}),
    message: `**${task.title}** claimed by @${task.assignee}`,
  });
}
```

Same pattern for `onCompleted`.

### Deserialization
`routes/tasks.mjs` already has a `deserializeTask()` helper that parses `metadata` from JSON string to object. The notifier receives deserialized tasks, so `task.metadata.mm_post_id` is accessible without extra parsing.

---

## Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC1 | When a new task notification is posted and Mattermost returns a post ID, `metadata.mm_post_id` is saved to the task in the database |
| AC2 | `onClaimed()` posts as a reply (`root_id` set) when `mm_post_id` is present in task metadata |
| AC3 | `onCompleted()` posts as a reply when `mm_post_id` is present |
| AC4 | Both methods fall back to standalone posts when `mm_post_id` is absent |
| AC5 | Metadata write failure does not crash the scheduler or affect task state |
| AC6 | Post ID storage does not add latency to sync operations (fire-and-forget update) |

---

## Test Plan

Tests live in `tests/mattermost/notify.test.mjs`.

| Test | Description |
|------|-------------|
| T1 | `onNewTask()` returns post ID when MM API responds with `{ id: "abc" }` |
| T2 | `onNewTask()` returns undefined when MM API fails — no crash |
| T3 | Scheduler stores `mm_post_id` in task metadata after successful `onNewTask()` |
| T4 | Scheduler skips metadata write when `onNewTask()` returns falsy |
| T5 | `onClaimed()` includes `root_id` in post body when task has `mm_post_id` |
| T6 | `onClaimed()` omits `root_id` when task has no `mm_post_id` |
| T7 | `onCompleted()` includes `root_id` when task has `mm_post_id` |
| T8 | `onCompleted()` omits `root_id` when no `mm_post_id` |
| T9 | Metadata DB write happens after scheduler upsert (verify order) |

---

## Affected Files

- `sync/scheduler.mjs` — capture and store post ID after `onNewTask()`
- `mattermost/notify.mjs` — add `root_id` to claim/complete posts
- `tests/mattermost/notify.test.mjs` — new test file

No schema changes required. `metadata` is already a JSON text column.

---

## Open Questions

1. **What if a task is notified more than once?** (e.g. re-synced after update) The current `onNewTask()` is called on every upsert in the scheduler. If a task already has `mm_post_id`, the scheduler should skip calling `onNewTask()` again to avoid duplicate posts. This is a scheduler concern, not a notifier concern — add a check: `if (!task.metadata?.mm_post_id) { ... notify ... }`.

2. **Thread vs. channel for claim/complete posts**: Should claim/complete always go to the same channel as the original post, or could the channel differ? Current design assumes the same channel (via `_getChannelId()`). If tasks can notify to different channels, the channel ID should also be stored in metadata.
