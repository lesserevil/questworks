# Plan: Migrate QuestWorks from Mattermost to Slack

## Overview

QuestWorks currently integrates with Mattermost via a bot token, a WebSocket connection, and a slash command endpoint. This plan replaces all of that with a proper Slack app using Bolt for JavaScript. The Mattermost code is removed entirely — there is no compatibility shim or fallback.

The core of the system (database, adapters, REST API, sync scheduler, dashboard, QuestBus) is platform-agnostic and requires no changes.

---

## What Gets Deleted

The entire `mattermost/` directory:

- `mattermost/notify.mjs` — Mattermost notifier
- `mattermost/bot.mjs` — Mattermost bot client (WebSocket, slash command registration)
- `mattermost/slash.mjs` — Slash command router and conversation engine
- `mattermost/websocket.mjs` — WebSocket listener for conversation continuations
- `mattermost/crypto.mjs` — **Keep this.** It handles adapter credential encryption and is not Mattermost-specific. Move it to a neutral location (see below).
- `mattermost/flows/index.mjs` — All conversational flows (rewritten for Slack, not deleted)

All `MM_URL`, `MM_BOT_TOKEN`, `MM_TEAM_ID`, `MM_CHANNEL` environment variables are removed.

---

## What Gets Created

### `slack/` directory (replaces `mattermost/`)

```
slack/
  app.mjs          — Slack Bolt app setup, registers listeners
  notify.mjs       — SlackNotifier (replaces MattermostNotifier)
  commands.mjs     — /qw slash command handler (replaces slash.mjs)
  conversations.mjs — Multi-step conversation state machine (replaces websocket.mjs listener)
  flows/
    index.mjs      — All flows ported from mattermost/flows/index.mjs
```

### `crypto.mjs` (moved to project root)

Move `mattermost/crypto.mjs` → `crypto.mjs` at the project root. Update all imports. This module has no Mattermost dependency; it just encrypts adapter credentials.

---

## Slack App Architecture

### Authentication Model

Mattermost used a single bot token. Slack uses OAuth. For a **single-workspace internal deployment**, a Slack app with a bot token (`xoxb-...`) and a signing secret is sufficient and mirrors the simplicity of the current setup.

Required Slack app scopes:
- `chat:write` — post messages
- `chat:write.public` — post to channels the bot hasn't joined
- `commands` — register `/qw` slash command
- `channels:read` — resolve channel names to IDs

### New Environment Variables

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Used to verify request signatures from Slack |
| `SLACK_CHANNEL` | Default notification channel name or ID (default: `paperwork`) |
| `QW_PUBLIC_URL` | Public URL for slash command endpoint (same as before) |

`MM_URL`, `MM_BOT_TOKEN`, `MM_TEAM_ID`, `MM_CHANNEL` are removed.

### Dependency Changes

Remove: `ws` (no longer needed — Slack Bolt handles the connection)

Add: `@slack/bolt` — the official Slack app framework

```json
"dependencies": {
  "@slack/bolt": "^3.x",
  "better-sqlite3": "^11.0.0",
  "express": "^5.0.0",
  "js-yaml": "^4.1.0",
  "postgres": "^3.4.8",
  "uuid": "^10.0.0"
}
```

---

## `slack/app.mjs` — Bolt App Setup

Initialize a `@slack/bolt` `App` with `token` and `signingSecret`. Export the app instance and a `start()` function.

Bolt runs its own HTTP receiver by default. Since QuestWorks already uses Express, use Bolt's `ExpressReceiver` so both share port 8788. Mount the Bolt receiver at `/slack/events` on the existing Express app.

```
POST /slack/events  — Bolt receiver (handles slash commands, interactive payloads, events)
```

The `startWebSocket` call in `server.mjs` is removed. Bolt handles the connection lifecycle.

---

## `slack/notify.mjs` — SlackNotifier

Drop-in replacement for `MattermostNotifier`. Implements the same interface:

- `onNewTask(task)` — Posts a task card to the configured channel using a Slack Block Kit message. Stores the returned `ts` (message timestamp) in `task.metadata.slack_ts` for thread replies.
- `onClaimed(task)` — Posts a reply in the task's thread (using `thread_ts: task.metadata.slack_ts`).
- `onCompleted(task)` — Posts a ✅ reply in the task's thread.
- `postMessage(channelId, text)` — Plain text post, used by the conversation engine.

Channel resolution: use `conversations.list` or `channels:read` to resolve a channel name to an ID on first use, then cache it. (Same pattern as the current `_getChannelId()` in `MattermostNotifier`.)

Slack Block Kit card for new tasks:
```
[Header: task title]
[Section: description (truncated to 300 chars)]
[Fields: Source | Priority | Labels]
[Button: View (links to external_url)]
```

---

## `slack/commands.mjs` — Slash Command Handler

Registers a `/qw` slash command handler with Bolt:

```js
app.command('/qw', async ({ command, ack, respond }) => { ... });
```

Key differences from the Mattermost implementation:

1. **Acknowledgment**: Call `ack()` immediately (Slack requires a response within 3 seconds). Then do async work and use `respond()` or the Web API to post the result.

2. **Payload fields**: Slack sends `command.user_id`, `command.channel_id`, `command.text`. These map directly to the existing `user_id`, `channel_id`, `text` fields used by the flow engine — minimal changes needed.

3. **Response visibility**: Use `respond({ text, response_type: 'in_channel' })` so the bot's reply is visible to the whole channel, matching current Mattermost behavior.

The `parseCommand()` function and `COMMAND_MAP` are reused unchanged.

---

## `slack/conversations.mjs` — Conversation Continuations

The current system uses a Mattermost WebSocket listener to route user messages into active conversation flows. In Slack, this is replaced by a **message event listener**:

```js
app.message(async ({ message, say }) => { ... });
```

The handler checks whether `message.user` + `message.channel` has an active conversation in the DB (same TTL logic as today). If so, it calls `flow.step()` and posts the result.

The `handleConversationReply` function signature stays the same — it just gets called by the Bolt message listener instead of the WebSocket handler.

---

## `slack/flows/index.mjs` — Ported Flows

All flows are functionally identical. The only changes are:

1. **`config_set_channel` flow**: The prompt changes from "Enter the Mattermost channel name" to "Enter the Slack channel name". The DB key changes from `mm_channel` to `slack_channel`.

2. **`config_show` flow**: No functional change; the stored key name changes as above.

3. **`help` flow**: Update help text to reference `/qw` as a Slack slash command (no behavioral change).

4. **Metadata key**: `mm_post_id` in task metadata becomes `slack_ts` (the Slack message timestamp used for threading).

All other flows (adapter add/remove/sync, task list/claim/done/block/add) are unchanged.

---

## `server.mjs` Changes

```diff
- import { MattermostNotifier } from './mattermost/notify.mjs';
- import { MattermostBot } from './mattermost/bot.mjs';
- import { createSlashRouter, handleConversationReply } from './mattermost/slash.mjs';
- import { decryptJson } from './mattermost/crypto.mjs';
- import { startWebSocket } from './mattermost/websocket.mjs';
+ import { SlackNotifier } from './slack/notify.mjs';
+ import { decryptJson } from './crypto.mjs';
+ import { initSlack } from './slack/app.mjs';

- const mmConfig = config.mattermost || {};
- const mmUrl = process.env.MM_URL || mmConfig.url || '';
- const mmToken = process.env.MM_BOT_TOKEN || mmConfig.token || '';
- const notifier = new MattermostNotifier({ url: mmUrl, token: mmToken, channel: mmConfig.channel });
- const bot = new MattermostBot({ url: mmUrl, token: mmToken });
+ const notifier = new SlackNotifier({
+   token: process.env.SLACK_BOT_TOKEN,
+   channel: process.env.SLACK_CHANNEL || config.slack?.channel || 'paperwork',
+ });

  // Auth middleware — skip /slack/events (Bolt verifies via signing secret)
  app.use((req, res, next) => {
    if (!AUTH_TOKEN) return next();
-   if (req.path === '/health' || req.path === '/' || req.path.startsWith('/slash')) return next();
+   if (req.path === '/health' || req.path === '/' || req.path.startsWith('/slack')) return next();
    ...
  });

- app.use('/slash', createSlashRouter(db));

+ // Mount Bolt receiver and register slash command + message handlers
+ await initSlack(app, db);

  app.listen(PORT, () => {
    ...
-   startWebSocket(db, handleConversationReply);
  });
```

The `config.yaml.example` is updated to document the new Slack env vars and remove all Mattermost references.

---

## `config.yaml.example` Changes

Remove the `mattermost:` section. Add:

```yaml
# slack:
#   channel: paperwork   # overridden by /qw config set channel
```

Document new env vars:
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_CHANNEL`

---

## Slack App Manifest

Add `slack-app-manifest.yaml` to the repo root for easy app creation in the Slack UI:

```yaml
display_information:
  name: QuestWorks
  description: Task routing and coordination for AI agents
features:
  slash_commands:
    - command: /qw
      url: $QW_PUBLIC_URL/slack/events
      description: QuestWorks task management
      usage_hint: "[task list | adapter add github | help | ...]"
      should_escape: false
  bot_user:
    display_name: questworks
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
      - commands
      - channels:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
    request_url: $QW_PUBLIC_URL/slack/events
  interactivity:
    is_enabled: false
```

---

## `AZURE_VM_SETUP.md` / `README.md` Changes

Update deployment docs:
- Remove Mattermost bot registration steps
- Add Slack app creation instructions (point to `slack-app-manifest.yaml`)
- Update env var references

---

## `AGENTS.md` Changes

Update the slash command section to reference `/qw` as a Slack slash command. No behavioral changes to the command set.

---

## Migration Steps (Implementation Order)

1. Move `mattermost/crypto.mjs` → `crypto.mjs`, update all imports, verify tests pass.
2. Add `@slack/bolt` to `package.json`, remove `ws`.
3. Create `slack/notify.mjs` (SlackNotifier).
4. Create `slack/flows/index.mjs` (port from `mattermost/flows/index.mjs` with minimal changes).
5. Create `slack/conversations.mjs` (handleConversationReply, unchanged logic).
6. Create `slack/commands.mjs` (Bolt `/qw` handler).
7. Create `slack/app.mjs` (Bolt app + ExpressReceiver wiring).
8. Update `server.mjs` (swap imports, remove MM wiring, call `initSlack`).
9. Update `config.yaml.example`, `README.md`, `AZURE_VM_SETUP.md`.
10. Add `slack-app-manifest.yaml`.
11. Delete `mattermost/` directory.
12. Update `AGENTS.md`.

---

## What Does NOT Change

- Database schema — no migrations needed
- All adapter code (`adapters/`, `sync/`)
- REST API routes (`routes/tasks.mjs`, `routes/adapters.mjs`)
- Dashboard
- QuestBus (SSE)
- Auth middleware (Bearer token)
- All conversational flow logic (task operations, adapter management)
- Encryption (just relocated)
