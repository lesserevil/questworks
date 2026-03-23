# questbus-receiver — OpenClaw Plugin

Receives QuestBus push messages from Dr. Quest (do-host1) via HTTP POST and injects them as system events into the running agent session.

## What it does

1. Registers `POST /questbus/receive` in the OpenClaw gateway
2. Validates incoming requests with a bearer token (`clawmeh` by default, or `SQUIRRELBUS_TOKEN` env var)
3. Appends received messages to the local `questbus/bus.jsonl` log
4. Queues a system event injection — at the next `before_prompt_build` hook, the message is prepended to the system prompt so the agent sees it immediately

The injected system event format:
```
System: [QuestBus] From @drquest: <subject or body, up to 200 chars>
```

## Install instructions for Race (puck) and Hadji (sparky)

### Step 1 — Get the plugin files

The plugin is available on MinIO at `do-host1/agents/shared/questbus-plugin.tar.gz`.

**Option A — from MinIO (if mc is configured):**
```bash
mc cp do-host1/agents/shared/questbus-plugin.tar.gz /tmp/
cd /tmp && tar xzf questbus-plugin.tar.gz
```

**Option B — direct copy** (if on the same Tailscale network):
```bash
scp drquest@100.89.199.14:/home/jkh/.openclaw/workspace/questbus-plugin.tar.gz /tmp/
cd /tmp && tar xzf questbus-plugin.tar.gz
```

### Step 2 — Install into your OpenClaw workspace

```bash
# Move plugin to your openclaw workspace plugins directory
cp -r /tmp/questbus-plugin ~/.openclaw/workspace/plugins/questbus-receiver

# Or install from the path directly:
openclaw plugins install /tmp/questbus-plugin
```

### Step 3 — Set the token (optional, 'clawmeh' is the default)

```bash
export SQUIRRELBUS_TOKEN=clawmeh
```

Or add to your agent's `.env`:
```
SQUIRRELBUS_TOKEN=clawmeh
```

### Step 4 — Ensure port 18789 is open (Tailscale-only)

The OpenClaw gateway must be reachable on port 18789 from do-host1 (100.89.199.14). This is typically already open on Tailscale.

Verify Dr. Quest can reach you:
```bash
# From do-host1:
curl -s http://<your-tailscale-ip>:18789/questbus/receive \
  -H "Authorization: Bearer clawmeh" \
  -H "Content-Type: application/json" \
  -d '{"from":"drquest","to":"all","body":"ping","type":"ping"}'
```

### Step 5 — Restart OpenClaw gateway

```bash
openclaw restart
# or if running directly:
pkill -f openclaw && openclaw serve &
```

## Expected addresses

| Agent      | Host   | Tailscale IP      | Push endpoint                                  |
|------------|--------|-------------------|------------------------------------------------|
| Race | puck   | 100.87.68.11      | http://100.87.68.11:18789/questbus/receive  |
| Hadji    | sparky | 100.87.229.125    | http://100.87.229.125:18789/questbus/receive|

Dr. Quest (do-host1) fans out to both endpoints after every `/bus/send` call, filtered by `to` field:
- `to: "all"` → fanout to both peers
- `to: "race"` → fanout only to Race
- `to: "hadji"` → fanout only to Hadji
- Messages from a peer are not bounced back to that peer

## Testing receipt

Once installed, post a test message via Dr. Quest:
```bash
curl -s http://100.89.199.14:8788/bus/send \
  -H "Authorization: Bearer wq-dash-token-2026" \
  -H "Content-Type: application/json" \
  -d '{"from":"drquest","to":"all","type":"text","body":"Hello from Dr. Quest via QuestBus push!"}'
```

You should see in your OpenClaw gateway logs:
```
📨 [QuestBus] PUSH from @drquest → all: System: [QuestBus] From @drquest: Hello from Dr. Quest via QuestBus push!
```
