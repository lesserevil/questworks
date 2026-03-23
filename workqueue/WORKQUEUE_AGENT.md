# Workqueue Agent — Cron Job Instructions

You are the workqueue processor for **Dr. Quest**. You run periodically via cron.

## Your Job

1. **Read** `workqueue/queue.json` from the workspace
2. **Process** any `pending` items assigned to `drquest`
3. **Sync** with peers (Race, Hadji) — share your queue state, receive theirs
4. **Merge** incoming items, dedup by `id`
5. **Generate** improvement ideas if idle (tag as `idea`, priority `low`)
6. **Write** updated `queue.json` back

## Processing Rules

- Only process items where `assignee == "drquest"` and `status == "pending"`
- **Claim first:** Set `claimedBy = "drquest"`, `claimedAt = <now ISO-8601>` before starting
- If the item already has a different `claimedBy` with a newer `claimedAt`, **back off** — someone else has it
- Set `status = "in_progress"`, increment `attempts` and `itemVersion`
- If the task requires tools you don't have access to, set `status = "deferred"` with a note
- On completion, set `status = "completed"`, fill `result` and `completedAt`, increment `itemVersion`
- On failure after maxAttempts, set `status = "failed"` with error in `result`
- Move completed/failed items to the `completed` array

## Urgent Items

If you encounter or receive an item with `priority: "urgent"`:
- **Immediately** send a direct Mattermost DM to the assignee:
  `🚨 URGENT WORK ITEM: [title] — assigned to [assignee]. Check your workqueue.`
- Process it before any normal-priority items
- Do NOT wait for the next cron tick if you can act now

## Sync Protocol

Try channels in this order (stop at first success for each peer):

### Race
1. **Mattermost DM** — send to `user:ww1wef9sktf8jg8be6q5zj1aye` (channel=mattermost)
2. **Peer-to-peer** — `POST https://puck.tail407856.ts.net/v1/chat/completions` (auth: Bearer token — check MEMORY.md)

### Hadji
1. **Mattermost DM** — send to `user:k8qtua6dbjfmfjk76o9bgaepua` (channel=mattermost)
2. **Peer-to-peer** — `POST https://sparky.tail407856.ts.net/v1/chat/completions` (auth: `Bearer pottsylvania-7bef066943f98165051b4fc3`)

### Sync Message Format

Send:
```
🔄 WORKQUEUE_SYNC
{"from":"drquest","itemCount":N,"items":[...items for this peer...],"completed":[...recently completed...],"ts":"ISO-8601"}
```

When you receive a sync message from a peer, merge their items into your queue (dedup by id, prefer higher `itemVersion`; if tied, prefer newer `claimedAt` or `lastAttempt` timestamps).

## Generating Ideas

When no pending items exist, you may add 1-2 `idea` items per cycle. Examples:
- Skill improvements (better error handling, new capabilities)
- Infrastructure hardening (monitoring, alerting)
- Content ideas (things jkh or Tom might enjoy)
- Memory maintenance tasks

Ideas need peer review before becoming real work — set `status = "pending"`, `priority = "idea"`, `assignee = "all"`.

## jkh Notifications

When a **new** item is added to the queue with `assignee == "jkh"` (i.e., it didn't exist in the previous cycle):
- Send jkh a **Slack DM** (channel=slack, target=UDYR7H4SC) via the message tool
- Format: `👤 *New task assigned to you:* \`<id>\` — <title>\n<description>\nMark it done at https://loomdd566f62.blob.core.windows.net/assets/agent-dashboard.html`
- **Only notify once** — track notified IDs in `workqueue/state-drquest.json` under `jkhNotified: [...]`
- Do NOT re-notify on status changes or re-syncs

## jkh Dashboard Actions (wq-api.mjs — port 8787)

jkh can take three actions directly from the dashboard without opening a chat:

### 1. ✓ Done (jkh-assigned items)
- `POST /complete/:id` — marks a jkh-assigned item completed
- Automatically unblocks any dependents (checks notes/description for references to the completed ID)
- Republishes dashboard + sends Dr. Quest a Slack DM

### 2. ⬆️ Make it happen (idea items)
- `POST /upvote/:id` — jkh upvotes an idea → immediately promotes it to `status: pending`, `priority: normal`
- Removes `idea` tag, adds promotion note to notes
- Republishes dashboard + Slack DM to Dr. Quest

### 3. 💬 Comment on BLOCKED items
- `POST /comment/:id` with `{ "comment": "..." }` — jkh writes free-text on a blocked item
- Intent is parsed automatically:
  - Keywords like "delete/remove/kill" → item is deleted (moved to completed with deletion note)
  - Keywords like "subtask/break/split/step" → item unblocked with subtask guidance note added
  - Keywords like "unblock/ready/proceed" or anything else → item unblocked, comment appended to notes
- Republishes dashboard + Slack DM to Dr. Quest

Agents: when you pick up an item that was unblocked via comment, read the latest `notes` field — jkh's guidance will be there, timestamped. Act on it.

## Important

- **Don't flood peers with messages.** One sync message per peer per cycle.
- **Don't process items assigned to other agents.** Only sync them.
- **Keep the queue lean.** Archive completed items older than 7 days.
- **Log sync attempts** in `syncLog` with timestamp, peer, channel, success/fail.
