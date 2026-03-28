import WebSocket from 'ws';

/**
 * Mattermost bot client — posts messages, registers slash commands, listens via WebSocket.
 */
export class MattermostBot {
  constructor({ url, token }) {
    this.url = url ? url.replace(/\/$/, '') : '';
    this.token = token || '';
    this.enabled = !!(this.url && this.token);
    this.botUserId = null;
    this._ws = null;
    this._wsSeq = 1;
    this._channelCache = new Map();
  }

  async init() {
    if (!this.enabled) return;
    try {
      const me = await this._get('/api/v4/users/me');
      this.botUserId = me?.id;
      console.log(`[bot] Authenticated as ${me?.username} (${me?.id})`);
    } catch (err) {
      console.error('[bot] Failed to authenticate:', err.message);
    }
  }

  async post(channelId, message) {
    if (!this.enabled) return null;
    return this._post('/api/v4/posts', { channel_id: channelId, message });
  }

  async getChannelIdByName(teamId, channelName) {
    const name = channelName.replace(/^#/, '');
    const cacheKey = `${teamId}:${name}`;
    if (this._channelCache.has(cacheKey)) return this._channelCache.get(cacheKey);
    const path = teamId
      ? `/api/v4/teams/${teamId}/channels/name/${name}`
      : `/api/v4/channels/name/${name}`;
    const ch = await this._get(path);
    if (ch?.id) this._channelCache.set(cacheKey, ch.id);
    return ch?.id || null;
  }

  async getTeams() {
    return this._get('/api/v4/teams') || [];
  }

  async registerSlashCommand(teamId, publicUrl) {
    if (!this.enabled || !teamId || !publicUrl) return false;
    const existing = await this._get(`/api/v4/teams/${teamId}/commands?custom_only=true&per_page=200`);
    if (Array.isArray(existing) && existing.some(c => c.trigger === 'qw')) {
      console.log('[bot] /qw slash command already registered');
      return true;
    }
    const result = await this._post('/api/v4/commands', {
      team_id: teamId,
      trigger: 'qw',
      method: 'P',
      callback_urls: [`${publicUrl}/slash`],
      display_name: 'QuestWorks',
      description: 'QuestWorks task management (/qw help for commands)',
      username: 'questworks',
    });
    if (result?.id) {
      console.log(`[bot] Registered /qw slash command (id: ${result.id})`);
      return true;
    }
    console.warn('[bot] Slash command registration failed');
    return false;
  }

  connectWebSocket(messageHandler) {
    if (!this.enabled) return;
    const wsUrl = this.url.replace(/^http/, 'ws') + '/api/v4/websocket';

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.on('open', () => {
        console.log('[bot] WebSocket connected');
        ws.send(JSON.stringify({
          seq: this._wsSeq++,
          action: 'authentication_challenge',
          data: { token: this.token },
        }));
      });

      ws.on('message', (raw) => {
        let event;
        try { event = JSON.parse(raw); } catch { return; }

        if (event.event === 'posted' && event.data?.post) {
          let post;
          try { post = JSON.parse(event.data.post); } catch { return; }

          // Skip bot's own messages and slash commands
          if (post.user_id === this.botUserId) return;
          if (post.message?.startsWith('/')) return;

          messageHandler({
            userId: post.user_id,
            channelId: post.channel_id,
            message: post.message || '',
            postId: post.id,
          }).catch(err => console.error('[bot] message handler error:', err.message));
        }
      });

      ws.on('close', () => {
        console.log('[bot] WebSocket closed, reconnecting in 5s...');
        setTimeout(connect, 5000);
      });

      ws.on('error', (err) => {
        console.error('[bot] WebSocket error:', err.message);
      });
    };

    connect();
  }

  async _post(path, body) {
    if (!this.enabled) return null;
    try {
      const res = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`[bot] POST ${path} → ${res.status}`);
        return null;
      }
      return res.json();
    } catch (err) {
      console.error(`[bot] POST ${path} error:`, err.message);
      return null;
    }
  }

  async _get(path) {
    if (!this.enabled) return null;
    try {
      const res = await fetch(`${this.url}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) return null;
      return res.json();
    } catch (err) {
      console.error(`[bot] GET ${path} error:`, err.message);
      return null;
    }
  }
}
