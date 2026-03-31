import WebSocket from 'ws';

const TTL_SECONDS = 5 * 60;

/**
 * Connect to Mattermost WebSocket and route incoming posts to active
 * conversation handlers. Only handles continuation messages — slash commands
 * start new conversations via POST /slash.
 *
 * @param {import('../db/index.mjs').SqliteDb|import('../db/index.mjs').PostgresDb} db
 * @param {(db: any, post: any) => Promise<void>} handleConversationReply
 */
export async function startWebSocket(db, handleConversationReply) {
  const mmUrl = process.env.MM_URL;
  if (!mmUrl) {
    console.warn('[ws] MM_URL not set — skipping WebSocket');
    return;
  }

  const tokenRow = await db.queryOne("SELECT value FROM config WHERE key = ?", ['mm_bot_token']);
  const token = tokenRow?.value || process.env.MM_BOT_TOKEN;
  if (!token) {
    console.warn('[ws] No mm_bot_token in config table and MM_BOT_TOKEN not set — skipping WebSocket');
    return;
  }

  const wsUrl = mmUrl.replace(/^http/, 'ws') + '/api/v4/websocket';

  let botUserId = null;
  try {
    const resp = await fetch(`${mmUrl}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const me = await resp.json();
      botUserId = me.id;
      console.log(`[ws] Bot user: ${me.username} (${me.id})`);
    }
  } catch (err) {
    console.warn('[ws] Could not fetch bot user ID:', err.message);
  }

  let stopped = false;
  let reconnectDelay = 2000;

  function connect() {
    if (stopped) return;
    console.log(`[ws] Connecting to ${wsUrl}`);
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('[ws] Connected');
      reconnectDelay = 2000;
      ws.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token } }));
    });

    ws.on('message', async (raw) => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      if (event.event !== 'posted') return;

      let post;
      try { post = JSON.parse(event.data?.post || '{}'); } catch { return; }

      const { user_id, channel_id, message, type } = post;
      if (type && type !== '') return; // skip system messages
      if (!user_id || user_id === botUserId) return;
      if (!message || !channel_id) return;

      // Only route if there is a non-expired active conversation
      const conv = await db.queryOne(
        'SELECT updated_at FROM conversations WHERE user_id=? AND channel_id=?',
        [user_id, channel_id]
      );
      if (!conv) return;

      if ((Math.floor(Date.now() / 1000) - conv.updated_at) > TTL_SECONDS) {
        await db.run('DELETE FROM conversations WHERE user_id=? AND channel_id=?', [user_id, channel_id]);
        return;
      }

      handleConversationReply(db, post).catch(err => {
        console.error('[ws] handleConversationReply error:', err.message);
      });
    });

    ws.on('error', (err) => console.error('[ws] Error:', err.message));

    ws.on('close', () => {
      if (stopped) return;
      console.log(`[ws] Disconnected — reconnecting in ${reconnectDelay}ms`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });
  }

  connect();
  return { stop() { stopped = true; } };
}
