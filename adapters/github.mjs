import { BaseAdapter, normalizeTask } from './base.mjs';
import { randomUUID } from 'crypto';

/**
 * GitHub Issues adapter.
 * Fetches issues with optional label filter, claims via assignment/comment,
 * updates via issue comments, closes by closing the issue.
 */
export class GitHubAdapter extends BaseAdapter {
  constructor(id, config) {
    super(id, config);
    this.repo = config.repo;       // "owner/repo"
    this.token = config.token;
    this.labelFilter = config.label_filter || null;
  }

  async pull() {
    // Label filter is required — intentional. Use /qw adapter add github to configure.
    if (!this.labelFilter) {
      console.log(`[github:${this.id}] no label_filter configured — skipping sync`);
      return [];
    }
    // TODO: implement GitHub API call
    // GET https://api.github.com/repos/{repo}/issues
    // Filter by label_filter if set
    // Map to QuestWorks task shape
    console.log(`[github:${this.id}] pull() stub — no real API call yet`);
    return [];
  }

  async claim(task) {
    // TODO: POST comment to issue saying it's been claimed
    console.log(`[github:${this.id}] claim() stub for ${task.external_id}`);
    return true;
  }

  async update(task, changes) {
    // TODO: POST comment with status update
    console.log(`[github:${this.id}] update() stub for ${task.external_id}`, changes);
  }

  async close(task) {
    // TODO: PATCH issue to closed state
    console.log(`[github:${this.id}] close() stub for ${task.external_id}`);
  }

  async health() {
    if (!this.token) return { ok: false, message: 'no token configured' };
    // TODO: GET /rate_limit to verify token works
    return { ok: true, message: 'stub (not verified)' };
  }
}
