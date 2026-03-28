import { BaseAdapter } from './base.mjs';

/**
 * Jira adapter.
 * Fetches issues from a Jira project, claims via transition/assignment,
 * updates via issue comments, closes via workflow transition.
 */
export class JiraAdapter extends BaseAdapter {
  constructor(id, config) {
    super(id, config);
    this.url = config.url;         // "https://company.atlassian.net"
    this.token = config.token;     // API token (user:token base64 or PAT)
    this.project = config.project; // project key e.g. "QUEST"
  }

  async pull() {
    // TODO: POST /rest/api/3/search with JQL: project={project} AND status=Open
    console.log(`[jira:${this.id}] pull() stub — no real API call yet`);
    return [];
  }

  async claim(task) {
    // TODO: transition issue to "In Progress" + assign to agent
    console.log(`[jira:${this.id}] claim() stub for ${task.external_id}`);
    return true;
  }

  async update(task, changes) {
    // TODO: POST /rest/api/3/issue/{id}/comment
    console.log(`[jira:${this.id}] update() stub for ${task.external_id}`, changes);
  }

  async close(task) {
    // TODO: transition issue to "Done"
    console.log(`[jira:${this.id}] close() stub for ${task.external_id}`);
  }

  async health() {
    if (!this.url || !this.token) return { ok: false, message: 'missing url or token' };
    return { ok: true, message: 'stub (not verified)' };
  }
}
