import { BaseAdapter, normalizeTask } from './base.mjs';
import { fetchJson, AdapterError, bearerAuth } from './http.mjs';

const MAX_DESCRIPTION_LENGTH = 4000;

/**
 * Beads adapter.
 * Connects QuestWorks to a Beads board via REST API.
 * Auth: Bearer token.
 * All HTTP calls go through fetchJson/bearerAuth from ./http.mjs.
 */
export class BeadsAdapter extends BaseAdapter {
  constructor(id, config) {
    super(id, config);
    this.endpoint = config.endpoint; // base URL, no trailing slash
    this.token = config.token;
    this.boardId = config.board_id;
  }

  /**
   * Returns true if required config fields are present.
   */
  _configValid() {
    return Boolean(this.endpoint && this.token && this.boardId);
  }

  /**
   * Build auth headers for all requests.
   */
  _auth() {
    return bearerAuth(this.token);
  }

  /**
   * Construct a display URL for a Beads task.
   */
  _taskUrl(taskId) {
    return `${this.endpoint}/boards/${this.boardId}/tasks/${taskId}`;
  }

  /**
   * Map a raw Beads task object to QuestWorks task shape via normalizeTask().
   * Handles both tags and labels field names (prefer tags).
   */
  _normalize(raw) {
    const labels = Array.isArray(raw.tags)
      ? raw.tags
      : Array.isArray(raw.labels)
        ? raw.labels
        : [];

    const priority = typeof raw.priority === 'number' ? raw.priority : 0;

    const description =
      typeof raw.description === 'string'
        ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH)
        : '';

    return normalizeTask({
      id: undefined, // assigned by QuestWorks
      source: this.id,
      externalId: String(raw.id),
      externalUrl: this._taskUrl(raw.id),
      title: raw.title || '',
      description,
      labels,
      priority,
      metadata: {
        beads_board_id: this.boardId,
        beads_task_id: String(raw.id),
      },
    });
  }

  /**
   * Fetch all open tasks from the configured board.
   * Follows next_cursor / next_url pagination until exhausted.
   * Returns [] if config is incomplete (no API call made).
   * Throws AdapterError on HTTP failures.
   *
   * @returns {Promise<object[]>}
   */
  async pull() {
    if (!this._configValid()) {
      console.warn(`[beads:${this.id}] pull() skipped — missing endpoint, token, or board_id`);
      return [];
    }

    const tasks = [];
    let url = `${this.endpoint}/api/boards/${this.boardId}/tasks?status=open`;

    while (url) {
      const page = await fetchJson(url, { headers: this._auth() });

      const items = Array.isArray(page.tasks)
        ? page.tasks
        : Array.isArray(page)
          ? page
          : [];

      for (const raw of items) {
        tasks.push(this._normalize(raw));
      }

      // Follow pagination if present
      if (page.next_url) {
        url = page.next_url;
      } else if (page.next_cursor) {
        const base = `${this.endpoint}/api/boards/${this.boardId}/tasks?status=open`;
        url = `${base}&cursor=${encodeURIComponent(page.next_cursor)}`;
      } else {
        url = null;
      }
    }

    return tasks;
  }

  /**
   * Mark a task as claimed in Beads.
   * Returns false on 409 (already claimed), true on success.
   * Throws AdapterError on other failures.
   *
   * @param {object} task - QuestWorks task object
   * @returns {Promise<boolean>}
   */
  async claim(task) {
    const url = `${this.endpoint}/api/tasks/${task.external_id}`;
    try {
      await fetchJson(url, {
        method: 'PATCH',
        headers: { ...this._auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'claimed', assignee: task.assignee }),
      });
      return true;
    } catch (err) {
      if (err instanceof AdapterError && err.status === 409) {
        console.warn(`[beads:${this.id}] claim() task ${task.external_id} already claimed`);
        return false;
      }
      throw err;
    }
  }

  /**
   * Push status and/or comment update back to Beads.
   * Sends a single PATCH with all provided changes.
   * Throws AdapterError on failure.
   *
   * @param {object} task - QuestWorks task object
   * @param {object} changes - { status?, comment? }
   */
  async update(task, changes) {
    const patch = {};
    if (changes.status !== undefined) patch.status = changes.status;
    if (changes.comment !== undefined) patch.comment = changes.comment;

    if (Object.keys(patch).length === 0) return;

    const url = `${this.endpoint}/api/tasks/${task.external_id}`;
    await fetchJson(url, {
      method: 'PATCH',
      headers: { ...this._auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  /**
   * Mark a task as done in Beads.
   * Silently ignores 404 (task already gone/closed).
   * Throws AdapterError on other failures.
   *
   * @param {object} task - QuestWorks task object
   */
  async close(task) {
    const url = `${this.endpoint}/api/tasks/${task.external_id}`;
    try {
      await fetchJson(url, {
        method: 'PATCH',
        headers: { ...this._auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      });
    } catch (err) {
      if (err instanceof AdapterError && err.status === 404) {
        console.warn(`[beads:${this.id}] close() task ${task.external_id} not found (already closed?)`);
        return;
      }
      throw err;
    }
  }

  /**
   * Health check — verify connectivity and auth.
   * Never throws.
   *
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async health() {
    if (!this.endpoint || !this.token) {
      return { ok: false, message: 'missing endpoint or token' };
    }

    try {
      await fetchJson(`${this.endpoint}/api/health`, { headers: this._auth() });
      return { ok: true, message: `Beads API reachable at ${this.endpoint}` };
    } catch (err) {
      if (err instanceof AdapterError && err.status === 401) {
        return { ok: false, message: 'token invalid or rejected' };
      }
      return { ok: false, message: err.message || 'unknown error' };
    }
  }
}
