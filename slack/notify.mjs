/**
 * Slack notification module.
 * Posts task cards when tasks arrive, updates threads when claimed/completed.
 */
export class SlackNotifier {
  constructor(config) {
    this.url = 'https://slack.com/api'; // Slack API base URL
    this.token = config.token;
    this.channel = config.channel || 'questworks';
    this.enabled = !!(this.token);
  }

  async onNewTask(task) {
    if (!this.enabled) return;
    const text = this._formatNewTask(task);
    const resp = await this._post('/chat.postMessage', {
      channel: await this._getChannelId(),
      text: text,
      attachments: [{
        title: task.title,
        title_link: task.external_url,
        text: task.description ? task.description.slice(0, 300) : '',
        fields: [
          { short: true, title: 'Source', value: task.source },
          { short: true, title: 'Priority', value: String(task.priority) },
          { short: true, title: 'Labels', value: (task.labels || []).join(', ') || '—' },
        ],
        color: '#0078d4',
      }]
    });

    // Store ts in task metadata for thread updates
    if (resp?.ts) {
      return resp.ts;
    }
  }

  // Alias for onNewTask - called when task is created via API
  async onCreated(task) {
    return this.onNewTask(task);
  }

  async onClaimed(task) {
    if (!this.enabled) return;
    const ts = task.metadata?.slack_ts;
    await this._post('/chat.postMessage', {
      channel: await this._getChannelId(),
      ...(ts ? { thread_ts: ts } : {}),
      text: `*${task.title}* claimed by @${task.assignee}`,
    });
  }

  async onCompleted(task) {
    if (!this.enabled) return;
    const ts = task.metadata?.slack_ts;
    await this._post('/chat.postMessage', {
      channel: await this._getChannelId(),
      ...(ts ? { thread_ts: ts } : {}),
      text: `✅ *${task.title}* completed`,
    });
  }

  // Post a plain message to a channel by ID
  async postMessage(channelId, text) {
    if (!this.enabled) return null;
    return this._post('/chat.postMessage', { channel: channelId, text: text });
  }

  _formatNewTask(task) {
    return `*New task from ${task.source}*: ${task.title}`;
  }

  async _getChannelId() {
    if (this._channelId) return this._channelId;
    const resp = await this._get('/conversations.list', { exclude_archived: true });
    if (resp?.channels) {
      const match = resp.channels.find(c => c.name === this.channel);
      if (match) {
        this._channelId = match.id;
        return this._channelId;
      }
    }
    // If channel not found, try to create it (requires proper scopes)
    console.warn(`[slack] Channel ${this.channel} not found`);
    return null;
  }

  async _post(path, body) {
    if (!this.enabled) return null;
    try {
      const response = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        console.error(`[slack] POST ${path} failed: ${response.status}`);
        return null;
      }
      return response.json();
    } catch (err) {
      console.error(`[slack] POST ${path} error:`, err.message);
      return null;
    }
  }

  async _get(path, query = {}) {
    if (!this.enabled) return null;
    try {
      const url = new URL(`${this.url}${path}`);
      Object.entries(query).forEach(([k, v]) => url.searchParams.append(k, v));
      const response = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (!response.ok) return null;
      return response.json();
    } catch (err) {
      console.error(`[slack] GET ${path} error:`, err.message);
      return null;
    }
  }
}