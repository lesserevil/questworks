/**
 * Mattermost notification module.
 * Posts task cards when tasks arrive, updates threads when claimed/completed.
 */
export class MattermostNotifier {
  constructor(config) {
    this.url = config.url;
    this.token = config.token;
    this.channel = config.channel || 'paperwork';
    this.enabled = !!(this.url && this.token);
  }

  async onNewTask(task) {
    if (!this.enabled) return;
    const text = this._formatNewTask(task);
    const resp = await this._post('/api/v4/posts', {
      channel_id: await this._getChannelId(),
      message: text,
      props: {
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
      }
    });

    // Store post_id in task metadata for thread updates
    if (resp?.id) {
      return resp.id;
    }
  }

  async onClaimed(task) {
    if (!this.enabled) return;
    const postId = task.metadata?.mm_post_id;
    await this._post('/api/v4/posts', {
      channel_id: await this._getChannelId(),
      ...(postId ? { root_id: postId } : {}),
      message: `**${task.title}** claimed by @${task.assignee}`,
    });
  }

  async onCompleted(task) {
    if (!this.enabled) return;
    const postId = task.metadata?.mm_post_id;
    await this._post('/api/v4/posts', {
      channel_id: await this._getChannelId(),
      ...(postId ? { root_id: postId } : {}),
      message: `✅ **${task.title}** completed`,
    });
  }

  // Post a plain message to a channel by ID
  async postMessage(channelId, text) {
    if (!this.enabled) return null;
    return this._post('/api/v4/posts', { channel_id: channelId, message: text });
  }

  _formatNewTask(task) {
    return `**New task from ${task.source}**: ${task.title}`;
  }

  async _getChannelId() {
    if (this._channelId) return this._channelId;
    const resp = await this._get(`/api/v4/channels/name/${this.channel}`);
    this._channelId = resp?.id;
    return this._channelId;
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
        console.error(`[mattermost] POST ${path} failed: ${response.status}`);
        return null;
      }
      return response.json();
    } catch (err) {
      console.error(`[mattermost] POST ${path} error:`, err.message);
      return null;
    }
  }

  async _get(path) {
    if (!this.enabled) return null;
    try {
      const response = await fetch(`${this.url}${path}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (!response.ok) return null;
      return response.json();
    } catch (err) {
      console.error(`[mattermost] GET ${path} error:`, err.message);
      return null;
    }
  }
}
