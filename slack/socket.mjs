/**
 * Slack Socket Mode client — receives slash commands, events, and interactions
 * over a persistent WebSocket instead of HTTP endpoints.
 *
 * Requires an App-Level Token (xapp-...) with the `connections:write` scope.
 * Set SLACK_APP_TOKEN in the environment (or slack.app_token in config.yaml).
 *
 * Slack app configuration:
 *   Settings → Socket Mode → Enable Socket Mode
 *   (No public Request URL needed for slash commands or event subscriptions.)
 *
 * Handles:
 *   slash_commands  → /qw command routing
 *   interactive     → modal (view_submission) processing
 *   events_api      → message events for conversation continuation
 */
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { flows, handleModalSubmit } from './flows/index.mjs';
import { postToSlack, openSlackModal, parseCommand, SLACK_API } from './api.mjs';

const TTL_MS = 5 * 60 * 1000;

// ── WebSocket URL retrieval ───────────────────────────────────────────────────

async function openConnection(appToken) {
  const res = await fetch(`${SLACK_API}/apps.connections.open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appToken}`, 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  if (!data.ok || !data.url) {
    throw new Error(`apps.connections.open failed: ${data.error || 'unknown'}`);
  }
  return data.url;
}

// ── Payload dispatcher ────────────────────────────────────────────────────────

async function dispatch(ws, envelope, db, adapters, scheduler, token) {
  const { envelope_id, type, payload } = envelope;

  // Always acknowledge first
  ws.send(JSON.stringify({ envelope_id }));

  if (type === 'slash_commands') {
    await handleSlashCommand(payload, db, adapters, scheduler, token);
  } else if (type === 'interactive') {
    await handleInteraction(payload, db, adapters, scheduler, token);
  } else if (type === 'events_api') {
    await handleEventCallback(payload, db, token);
  }
}

// ── Slash command handler ─────────────────────────────────────────────────────

async function handleSlashCommand(payload, db, adapters, scheduler, token) {
  const { user_id, channel_id, text, trigger_id } = payload || {};
  if (!user_id || !channel_id) return;

  const parsed = parseCommand(text || '');
  if (!parsed) {
    await postToSlack(token, channel_id, 'Unknown command. Try `/qw help`.');
    return;
  }

  const { flowName, args } = parsed;
  const flow = flows[flowName];
  if (!flow) {
    await postToSlack(token, channel_id, `Unknown flow: \`${flowName}\`.`);
    return;
  }

  await db.run('DELETE FROM conversations WHERE user_id=? AND channel_id=?', [user_id, channel_id]);

  let result;
  try {
    result = await flow.start(db, user_id, channel_id, args);
  } catch (err) {
    console.error(`[socket] flow.start(${flowName}) error:`, err);
    await postToSlack(token, channel_id, `Error starting \`${flowName}\`: ${err.message}`);
    return;
  }

  if (result.modal && result.modalDef) {
    if (!trigger_id) {
      await postToSlack(token, channel_id, '⚠️ Cannot open form: `trigger_id` not provided.');
      return;
    }
    await openSlackModal(token, trigger_id, { flowName, userId: user_id, channelId: channel_id }, result.modalDef);
    return;
  }

  await postToSlack(token, channel_id, result.message);

  if (!result.done) {
    const now = new Date().toISOString();
    await db.run(
      'INSERT INTO conversations (id, user_id, channel_id, flow, step, data, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      [randomUUID(), user_id, channel_id, flowName, '{}', now, now]
    );
  }
}

// ── Interactive (modal submission) handler ────────────────────────────────────

async function handleInteraction(payload, db, adapters, scheduler, token) {
  if (payload?.type !== 'view_submission') return;

  const view = payload.view || {};
  let context = {};
  try { context = JSON.parse(view.private_metadata || '{}'); } catch { /* use empty */ }

  const { flowName, channelId } = context;
  if (!flowName) return;

  let message;
  try {
    message = await handleModalSubmit(db, flowName, view.state?.values, adapters, scheduler);
  } catch (err) {
    message = `Error saving: ${err.message}`;
  }

  if (message && channelId) {
    await postToSlack(token, channelId, message);
  }
}

// ── Events API (message events) handler ──────────────────────────────────────

async function handleEventCallback(payload, db, token) {
  const event = payload?.event;
  if (!event || event.type !== 'message') return;
  if (event.subtype) return;    // edited, deleted, bot_message, etc.
  if (event.bot_id) return;
  if (!event.user || !event.channel || !event.text) return;

  await handleConversationReply(db, {
    user_id: event.user,
    channel_id: event.channel,
    message: event.text,
  }, token);
}

// ── Conversation reply handler ────────────────────────────────────────────────

async function handleConversationReply(db, post, token) {
  const { user_id, channel_id, message } = post;

  const conv = await db.queryOne(
    'SELECT * FROM conversations WHERE user_id=? AND channel_id=?',
    [user_id, channel_id]
  );
  if (!conv) return;

  const updatedAtMs = /^\d+(\.\d+)?$/.test(String(conv.updated_at))
    ? Number(conv.updated_at) * 1000
    : new Date(conv.updated_at).getTime();
  if (Date.now() - updatedAtMs > TTL_MS) {
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  const flow = flows[conv.flow];
  if (!flow) {
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  const convWithData = {
    ...conv,
    data: typeof conv.data === 'string' ? JSON.parse(conv.data || '{}') : (conv.data ?? {}),
  };

  let result;
  try {
    result = await flow.step(db, convWithData, message || '');
  } catch (err) {
    console.error(`[socket] flow.step(${conv.flow}) error:`, err);
    await postToSlack(token, channel_id, `Error: ${err.message}`);
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  await postToSlack(token, channel_id, result.message);

  if (result.done) {
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
  } else {
    const newStep = result.step !== undefined ? result.step : conv.step + 1;
    const newData = result.data !== undefined ? JSON.stringify(result.data) : conv.data;
    await db.run(
      'UPDATE conversations SET step=?, data=?, updated_at=? WHERE id=?',
      [newStep, newData, new Date().toISOString(), conv.id]
    );
  }
}

// ── Socket Mode entry point ───────────────────────────────────────────────────

export async function startSocketMode(db, adapters, scheduler, { token = '', appToken = '' } = {}) {
  if (!appToken) {
    console.warn('[socket] SLACK_APP_TOKEN not set — Socket Mode disabled');
    return null;
  }

  let stopped = false;
  let reconnectDelay = 2000;

  async function connect() {
    if (stopped) return;

    let wsUrl;
    try {
      wsUrl = await openConnection(appToken);
    } catch (err) {
      console.error('[socket] Failed to get WebSocket URL:', err.message);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      return;
    }

    console.log('[socket] Connecting to Slack Socket Mode');
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('[socket] Connected');
      reconnectDelay = 2000;
    });

    ws.on('message', (raw) => {
      let envelope;
      try { envelope = JSON.parse(raw); } catch { return; }

      // Slack sends a hello on connect — ignore it
      if (envelope.type === 'hello') return;

      // Disconnect requests — reconnect with a fresh URL
      if (envelope.type === 'disconnect') {
        console.log('[socket] Slack requested disconnect, reconnecting...');
        ws.close();
        return;
      }

      dispatch(ws, envelope, db, adapters, scheduler, token).catch(err =>
        console.error('[socket] dispatch error:', err.message)
      );
    });

    ws.on('error', (err) => console.error('[socket] WebSocket error:', err.message));

    ws.on('close', () => {
      if (stopped) return;
      console.log(`[socket] Disconnected — reconnecting in ${reconnectDelay}ms`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });
  }

  await connect();
  return { stop() { stopped = true; } };
}
