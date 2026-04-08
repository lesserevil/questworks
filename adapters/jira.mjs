/**
 * adapters/jira.mjs — Jira adapter for QuestWorks.
 *
 * Supports **Jira Server / Data Center** (REST API v2, Bearer token auth).
 * Jira Cloud (API v3, Basic auth) is not supported.
 *
 * All HTTP calls use adapters/http.mjs (fetchJson, AdapterError, bearerAuth).
 * No credentials are logged or included in error messages.
 */

import { BaseAdapter, normalizeTask } from './base.mjs';
import { fetchJson, AdapterError, bearerAuth } from './http.mjs';

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
 * Extract plain text from a Jira Server description field.
 * Handles: null, plain string (Server), or ADF object (ignored).
 *
 * @param {string|object|null} description
 * @returns {string}
 */
function extractDescription(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  return '';
}

export class JiraAdapter extends BaseAdapter {
  /**
   * @param {string} id  Adapter instance ID
   * @param {object} config
   * @param {string} config.url      Jira Server base URL (e.g. https://jira.example.com)
   * @param {string} config.token    Jira Server personal access token (PAT)
   * @param {string} config.project  Jira project key (e.g. QUEST)
   * @param {string} [config.jql]                    Optional extra JQL filter
   * @param {string} [config.in_progress_transition]  Transition name for claim (default: 'In Progress')
   * @param {string} [config.done_transition]         Transition name for close (default: 'Done')
   * @param {object} [_http]  Optional HTTP overrides for testing (e.g. { fetchJson })
   */
  constructor(id, config, _http = {}) {
    super(id, config);
    /** @private — allow injection for tests */
    this._fetchJson = _http.fetchJson || fetchJson;
    this.baseUrl = config.url.replace(/\/$/, '');
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
      ...bearerAuth(this.token),
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
        `${this.baseUrl}/rest/api/2/issue/${issueKey}/transitions`,
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
    const conditions = [`project=${this.project}`, 'statusCategory != Done'];
    if (this.jql) conditions.push(this.jql);
    const baseJql = conditions.join(' AND ') + ' ORDER BY created ASC';
    const maxResults = 50;
    const tasks = [];

    try {
      let startAt = 0;
      let total = Infinity;

      while (startAt < total) {
        const params = new URLSearchParams({
          jql: baseJql,
          startAt: String(startAt),
          maxResults: String(maxResults),
          fields: 'summary,description,status,priority,labels,issuetype,assignee',
        });

        const data = await this._fetchJson(
          `${this.baseUrl}/rest/api/2/search?${params}`,
          { headers: this._headers() },
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
   * Assign the Jira issue to the token owner and transition it to In Progress.
   * Returns true on success, false on any error.
   *
   * @param {object} task  QuestWorks task (must have .external_id = Jira key)
   * @returns {Promise<boolean>}
   */
  async claim(task) {
    const key = task.external_id;
    try {
      // Transition to In Progress
      const transitionId = await this._getTransitionId(key, this.inProgressTransition);
      if (!transitionId) {
        const available = Object.keys(this._transitionCache.get(key) || {}).join(', ');
        console.error(`[jira:${this.id}] claim(${key}): transition "${this.inProgressTransition}" not found. Available: ${available}`);
        return false;
      }

      await this._fetchJson(`${this.baseUrl}/rest/api/2/issue/${key}/transitions`, {
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
   * Push a plain-text comment to the Jira issue when changes.comment is present.
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
      await this._fetchJson(`${this.baseUrl}/rest/api/2/issue/${key}/comment`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ body: changes.comment }),
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
      await this._fetchJson(`${this.baseUrl}/rest/api/2/issue/${key}/transitions`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ transition: { id: transitionId } }),
      });
    } catch (err) {
      console.error(`[jira:${this.id}] close(${key}) failed:`, err instanceof AdapterError ? `HTTP ${err.status}` : err.message);
    }
  }

  /**
   * Health check — verifies credentials by calling /rest/api/2/myself.
   *
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async health() {
    try {
      const data = await this._fetchJson(`${this.baseUrl}/rest/api/2/myself`, {
        headers: this._headers(),
      });
      return { ok: true, message: `authenticated as ${data.displayName}` };
    } catch (err) {
      const msg = err instanceof AdapterError ? `HTTP ${err.status}` : err.message;
      return { ok: false, message: msg };
    }
  }
}
