import WebSocket from 'ws';

const CONV_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Connects to the Mattermost WebSocket API and routes incoming posts to active
 * conversation handlers. Only slash commands start new conversations — the WS
 * listener only handles continuation messages.
 */
export class MattermostWebSocket {
  constructor(mmUrl, token, db, onMessage) {
    this.wsUrl = mmUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + '/api/v4/websocket';
    this.httpUrl = mmUrl;
    this.token = token;
    this.db = db;
    this.onMessage = onMessage; // async (userId, channelId, text) => void
    this.botUserId = null;
    this._ws = null;
    this._reconnectDelay = 2000;
    this._stopped = false;
  }

  async start() {
    // Fetch bot user ID once so we can ignore our own posts
    try {
      const resp = await fetch(`${this.httpUrl}/api/v4/users/me`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (resp.ok) {
        const me = await resp.json();
        this.botUserId = me.id;
        console.log(`[ws] Bot user ID: ${this.botUserId}`);
      }
    } catch (err) {
      console.warn('[ws] Could not fetch bot user ID:', err.message);
    }

    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
  }

  _connect() {
    if (this._stopped) return;

    console.log(`[ws] Connecting to ${this.wsUrl}`);
    const ws = new WebSocket(this.wsUrl);
    this._ws = ws;

    ws.on('open', () => {
      console.log('[ws] Connected');
      this._reconnectDelay = 2000;
      // Authenticate
      ws.send(JSON.stringify({
        seq: 1,
        action: 'authentication_challenge',
        data: { token: this.token },
      }));
    });

    ws.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      this._handleEvent(event);
    });

    ws.on('error', (err) => {
      console.error('[ws] Error:', err.message);
    });

    ws.on('close', () => {
      if (this._stopped) return;
      console.log(`[ws] Disconnected — reconnecting in ${this._reconnectDelay}ms`);
      setTimeout(() => this._connect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    });
  }

  _handleEvent(event) {
    if (event.event !== 'posted') return;

    let post;
    try {
      post = JSON.parse(event.data?.post || '{}');
    } catch { return; }

    const { user_id, channel_id, message, type } = post;

    // Ignore system messages and our own posts
    if (type && type !== '') return;
    if (!user_id || user_id === this.botUserId) return;
    if (!message || !channel_id) return;

    // Only route if there is an active (non-expired) conversation
    const conv = this._getActiveConversation(user_id, channel_id);
    if (!conv) return;

    this.onMessage(user_id, channel_id, message.trim()).catch(err => {
      console.error('[ws] onMessage error:', err.message);
    });
  }

  _getActiveConversation(userId, channelId) {
    const conv = this.db.prepare(
      'SELECT * FROM conversations WHERE user_id=? AND channel_id=? ORDER BY updated_at DESC LIMIT 1'
    ).get(userId, channelId);
    if (!conv) return null;
    const age = Date.now() - new Date(conv.updated_at).getTime();
    if (age > CONV_TTL_MS) {
      this.db.prepare('DELETE FROM conversations WHERE id=?').run(conv.id);
      return null;
    }
    return conv;
  }
}
