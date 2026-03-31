import { BaseAdapter, normalizeTask } from './base.mjs';
import { AdapterError, bearerAuth, fetchJson } from './http.mjs';
import { randomUUID } from 'crypto';

const GITHUB_API = 'https://api.github.com';

/**
 * GitHub Issues adapter.
 * Fetches issues with optional label filter, claims via comment,
 * updates via issue comments, closes by patching issue state.
 */
export class GitHubAdapter extends BaseAdapter {
  constructor(id, config) {
    super(id, config);
    this.repo = config.repo;             // "owner/repo"
    this.token = config.token;
    this.labelFilter = config.label_filter || null;
  }

  /**
   * Build shared request headers for GitHub API calls.
   * @returns {object}
   */
  #headers() {
    return {
      ...bearerAuth(this.token),
      'User-Agent': 'questworks/1.0',
      'Accept': 'application/vnd.github+json',
    };
  }

  /**
   * Parse the Link header and return the URL for rel="next", or null.
   * @param {string|null} linkHeader
   * @returns {string|null}
   */
  #parseNextLink(linkHeader) {
    if (!linkHeader) return null;
    // Link: <url>; rel="next", <url>; rel="last"
    const parts = linkHeader.split(',');
    for (const part of parts) {
      const match = part.match(/<([^>]+)>;\s*rel="next"/);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Map a raw GitHub issue to a QuestWorks task via normalizeTask().
   * @param {object} issue
   * @returns {object}
   */
  #mapIssue(issue) {
    return normalizeTask({
      id: randomUUID(),
      source: this.id,
      externalId: String(issue.number),
      externalUrl: issue.html_url,
      title: issue.title,
      description: (issue.body || '').slice(0, 4000),
      labels: (issue.labels || []).map((l) => l.name),
      priority: 0,
      metadata: {
        github_number: issue.number,
        github_node_id: issue.node_id,
      },
    });
  }

  async pull() {
    if (!this.labelFilter) {
      console.log(`[github:${this.id}] no label_filter configured — skipping sync`);
      return [];
    }

    const tasks = [];
    let url = `${GITHUB_API}/repos/${this.repo}/issues?labels=${encodeURIComponent(this.labelFilter)}&state=open&per_page=100`;

    while (url) {
      // fetchJson doesn't expose response headers, so we need raw fetch for pagination
      let response;
      try {
        response = await fetch(url, { headers: this.#headers() });
      } catch (err) {
        throw new AdapterError(err.message, 0, null);
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const body = await response.text().catch(() => null);
        throw new AdapterError(
          `HTTP 429 Too Many Requests${retryAfter ? ` (Retry-After: ${retryAfter})` : ''}`,
          429,
          body,
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => null);
        throw new AdapterError(
          `HTTP ${response.status} ${response.statusText}`,
          response.status,
          body,
        );
      }

      const issues = await response.json();
      for (const issue of issues) {
        tasks.push(this.#mapIssue(issue));
      }

      const linkHeader = response.headers.get('Link');
      url = this.#parseNextLink(linkHeader);
    }

    return tasks;
  }

  async claim(task) {
    const url = `${GITHUB_API}/repos/${this.repo}/issues/${task.external_id}/comments`;
    try {
      await fetchJson(url, {
        method: 'POST',
        headers: {
          ...this.#headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: `🔬 Claimed by ${task.assignee || 'agent'}` }),
      });
      return true;
    } catch (err) {
      console.error(`[github:${this.id}] claim() failed for ${task.external_id}: ${err.message}`);
      return true; // claim in QuestWorks is already committed
    }
  }

  async update(task, changes) {
    if (!changes.comment && !changes.status) return;

    let commentBody;
    if (changes.comment && changes.status) {
      commentBody = `${changes.comment}\n\nStatus → ${changes.status}`;
    } else if (changes.comment) {
      commentBody = changes.comment;
    } else {
      commentBody = `Status → ${changes.status}`;
    }

    const url = `${GITHUB_API}/repos/${this.repo}/issues/${task.external_id}/comments`;
    try {
      await fetchJson(url, {
        method: 'POST',
        headers: {
          ...this.#headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: commentBody }),
      });
    } catch (err) {
      console.error(`[github:${this.id}] update() failed for ${task.external_id}: ${err.message}`);
    }
  }

  async close(task) {
    const issueUrl = `${GITHUB_API}/repos/${this.repo}/issues/${task.external_id}`;

    try {
      await fetchJson(issueUrl, {
        method: 'PATCH',
        headers: {
          ...this.#headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: 'closed' }),
      });
    } catch (err) {
      if (err instanceof AdapterError && err.status === 404) {
        console.log(`[github:${this.id}] close(): issue ${task.external_id} already closed`);
      } else {
        console.error(`[github:${this.id}] close() patch failed for ${task.external_id}: ${err.message}`);
        return;
      }
    }

    // Post completion comment
    const commentUrl = `${GITHUB_API}/repos/${this.repo}/issues/${task.external_id}/comments`;
    try {
      await fetchJson(commentUrl, {
        method: 'POST',
        headers: {
          ...this.#headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: `✅ Completed by ${task.assignee || 'agent'}` }),
      });
    } catch (err) {
      console.error(`[github:${this.id}] close() comment failed for ${task.external_id}: ${err.message}`);
    }
  }

  async health() {
    if (!this.token) return { ok: false, message: 'no token configured' };
    try {
      const data = await fetchJson(`${GITHUB_API}/rate_limit`, {
        headers: this.#headers(),
      });
      const { remaining, limit } = data.rate;
      return { ok: true, message: `GitHub API reachable, ${remaining}/${limit} requests remaining` };
    } catch (err) {
      if (err instanceof AdapterError && err.status === 401) {
        return { ok: false, message: 'token invalid or expired' };
      }
      return { ok: false, message: err.message };
    }
  }
}
