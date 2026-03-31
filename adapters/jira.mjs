/**
 * adapters/jira.mjs — Jira adapter for QuestWorks.
 *
 * Connects to a Jira Cloud instance, pulling issues as tasks and reflecting
 * claim/status/close back via the Jira REST API v3.
 *
 * All HTTP calls use adapters/http.mjs (fetchJson, AdapterError, basicAuth).
 * No credentials are logged or included in error messages.
 */

import { BaseAdapter, normalizeTask } from './base.mjs';
import { fetchJson, AdapterError, basicAuth } from './http.mjs';

/** Map Jira priority names to QuestWorks priority numbers. */
function mapPriority(name) {
  switch ((name || '').toLowerCase()) {
    case 'highest': return 4;
    case 'high':    return 3;
    case 'medium':  return 2;
    case 'low':     return 1;
    case 'lowest':  return 0;
    default:        return 2;
  }
}

/**
 * Extract plain text from a Jira description field.
 * Handles: null, plain string, or ADF object.
 *
 * @param {string|object|null} description
 * @returns {string}
 */
function extractDescription(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  // ADF object — extract text from content nodes
  if (description.content && Array.isArray(description.content)) {
    const parts = [];
    for (const block of description.content) {
      if (block.content && Array.isArray(block.content)) {
        for (const inline of block.content) {
          if (inline.type === 'text' && inline.text) parts.push(inline.text);
        }
      }
    }
    return parts.join(' ');
  }
  return '';
}

/**
 * Wrap plain text in minimal Atlassian Document Format for Jira comments.
 *
 * @param {string} text
 * @returns {object}
 */
function adfComment(text) {
  return {
    body: {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text }],
        },
      ],
    },
  };
}

export class JiraAdapter extends BaseAdapter {
  /**
   * @param {string} id  Adapter instance ID
   * @param {object} config
   * @param {string} config.url                     Jira base URL (e.g. https://company.atlassian.net)
   * @param {string} config.email                   Jira Cloud user email
   * @param {string} config.token                   Jira Cloud API token
   * @param {string} config.project                 Jira project key (e.g. QUEST)
   * @param {string} [config.jql]                   Optional extra JQL filter
   * @param {string} [config.in_progress_transition] Transition name for claim (default: 'In Progress')
   * @param {string} [config.done_transition]        Transition name for close (default: 'Done')
   * @param {object} [_http]  Optional HTTP overrides for testing (e.g. { fetchJson })
   */
  constructor(id, config, _http = {}) {
    super(id, config);
    /** @private — allow injection for tests */
    this._fetchJson = _http.fetchJson || fetchJson;
    this.baseUrl = config.url.replace(/\/$/, '');
    this.email = config.email;
    this.token = config.token;
    this.project = config.project;
    this.jql = config.jql || '';
    this.inProgressTransition = config.in_progress_transition || 'In Progress';
    this.doneTransition = config.done_transition || 'Done';
    /** @type {Map<string, Record<string, string>>} issueKey -> { transitionName -> transitionId } */
    this._transitionCache = new Map();
  }

  /** @returns {{ Authorization: string, 'Content-Type': string, Accept: string }} */
  _headers() {
    return {
      ...basicAuth(this.email, this.token),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Look up the transition ID for a named transition on an issue.
   * Caches results per issue key for the lifetime of this adapter instance.
   *
   * @param {string} issueKey  e.g. 'QUEST-42'
   * @param {string} transitionName  e.g. 'In Progress'
   * @returns {Promise<string|null>}  Transition ID or null if not found
   */
  async _getTransitionId(issueKey, transitionName) {
    if (!this._transitionCache.has(issueKey)) {
      const data = await this._fetchJson(
        `${this.baseUrl}/rest/api/3/issue/${issueKey}/transitions`,
        { headers: this._headers() },
      );
      const map = {};
      for (const t of data.transitions) map[t.name] = t.id;
      this._transitionCache.set(issueKey, map);
    }
    return this._transitionCache.get(issueKey)[transitionName] ?? null;
  }

  /**
   * Fetch open issues from Jira and return them as QuestWorks tasks.
   * Paginates automatically (50 per page).
   * Returns [] and logs on connection/API errors — never throws.
   *
   * @returns {Promise<object[]>}
   */
  async pull() {
    const baseJql = `project=${this.project} AND statusCategory != Done ORDER BY created ASC` +
      (this.jql ? ` AND ${this.jql}` : '');
    const maxResults = 50;
    const tasks = [];

    try {
      let startAt = 0;
      let total = Infinity;

      while (startAt < total) {
        const data = await this._fetchJson(
          `${this.baseUrl}/rest/api/3/search`,
          {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({ jql: baseJql, startAt, maxResults, fields: ['summary', 'description', 'status', 'priority', 'labels', 'issuetype', 'assignee'] }),
          },
        );

        total = data.total;
        for (const issue of data.issues) {
          tasks.push(normalizeTask({
            id: `jira:${issue.key}`,
            source: this.id,
            externalId: issue.key,
            externalUrl: `${this.baseUrl}/browse/${issue.key}`,
            title: issue.fields.summary,
            description: extractDescription(issue.fields.description),
            labels: issue.fields.labels || [],
            priority: mapPriority(issue.fields.priority?.name),
            metadata: {
              jira_status: issue.fields.status?.name,
              issue_type: issue.fields.issuetype?.name,
            },
          }));
        }

        startAt += data.issues.length;
        // Guard against empty page to avoid infinite loop
        if (data.issues.length === 0) break;
      }
    } catch (err) {
      console.error(`[jira:${this.id}] pull() failed:`, err instanceof AdapterError ? `HTTP ${err.status}` : err.message);
      return [];
    }

    return tasks;
  }

  /**
   * Assign the Jira issue to the service account and transition it to In Progress.
   * Returns true on success, false on any error.
   *
   * @param {object} task  QuestWorks task (must have .external_id = Jira key)
   * @returns {Promise<boolean>}
   */
  async claim(task) {
    const key = task.external_id;
    try {
      // Assign to service account (email used as accountId lookup — Jira Cloud uses accountId)
      // For Cloud: use assignee: { accountId } if known. Fallback: name (Server) or email (Cloud).
      await this._fetchJson(`${this.baseUrl}/rest/api/3/issue/${key}/assignee`, {
        method: 'PUT',
        headers: this._headers(),
        body: JSON.stringify({ emailAddress: this.email }),
      });

      // Transition to In Progress
      const transitionId = await this._getTransitionId(key, this.inProgressTransition);
      if (!transitionId) {
        const available = Object.keys(this._transitionCache.get(key) || {}).join(', ');
        console.error(`[jira:${this.id}] claim(${key}): transition "${this.inProgressTransition}" not found. Available: ${available}`);
        return false;
      }

      await this._fetchJson(`${this.baseUrl}/rest/api/3/issue/${key}/transitions`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ transition: { id: transitionId } }),
      });

      return true;
    } catch (err) {
      console.error(`[jira:${this.id}] claim(${key}) failed:`, err instanceof AdapterError ? `HTTP ${err.status}` : err.message);
      return false;
    }
  }

  /**
   * Push a comment to the Jira issue when changes.comment is present.
   * Status-only changes are ignored (QuestWorks-internal).
   * Logs errors but does not throw.
   *
   * @param {object} task
   * @param {{ comment?: string, status?: string }} changes
   */
  async update(task, changes) {
    if (!changes.comment) return;
    const key = task.external_id;
    try {
      await this._fetchJson(`${this.baseUrl}/rest/api/3/issue/${key}/comment`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(adfComment(changes.comment)),
      });
    } catch (err) {
      console.error(`[jira:${this.id}] update(${key}) comment failed:`, err instanceof AdapterError ? `HTTP ${err.status}` : err.message);
    }
  }

  /**
   * Transition the Jira issue to Done.
   * Logs errors but does not throw.
   *
   * @param {object} task
   */
  async close(task) {
    const key = task.external_id;
    try {
      const transitionId = await this._getTransitionId(key, this.doneTransition);
      if (!transitionId) {
        const available = Object.keys(this._transitionCache.get(key) || {}).join(', ');
        console.error(`[jira:${this.id}] close(${key}): transition "${this.doneTransition}" not found. Available: ${available}`);
        return;
      }
      await this._fetchJson(`${this.baseUrl}/rest/api/3/issue/${key}/transitions`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ transition: { id: transitionId } }),
      });
    } catch (err) {
      console.error(`[jira:${this.id}] close(${key}) failed:`, err instanceof AdapterError ? `HTTP ${err.status}` : err.message);
    }
  }

  /**
   * Health check — verifies credentials by calling /rest/api/3/myself.
   *
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async health() {
    try {
      const data = await this._fetchJson(`${this.baseUrl}/rest/api/3/myself`, {
        headers: this._headers(),
      });
      return { ok: true, message: `authenticated as ${data.displayName}` };
    } catch (err) {
      const msg = err instanceof AdapterError ? `HTTP ${err.status}` : err.message;
      return { ok: false, message: msg };
    }
  }
}
