import { BaseAdapter, normalizeTask } from './base.mjs';
import { randomUUID } from 'crypto';

/**
 * Beads adapter.
 * Beads is a first-class external task source — same interface as GitHub/Jira.
 * Fetches tasks from a Beads board, claims/updates/closes via REST API.
 */
export class BeadsAdapter extends BaseAdapter {
  constructor(id, config) {
    super(id, config);
    this.endpoint = config.endpoint; // base URL of Beads instance
    this.token = config.token;
    this.boardId = config.board_id;
  }

  async pull() {
    // TODO: GET {endpoint}/api/boards/{board_id}/tasks?status=open
    console.log(`[beads:${this.id}] pull() stub — no real API call yet`);
    return [];
  }

  async claim(task) {
    // TODO: PATCH {endpoint}/api/tasks/{external_id} { status: "claimed", assignee: agent }
    console.log(`[beads:${this.id}] claim() stub for ${task.external_id}`);
    return true;
  }

  async update(task, changes) {
    // TODO: PATCH task + POST comment
    console.log(`[beads:${this.id}] update() stub for ${task.external_id}`, changes);
  }

  async close(task) {
    // TODO: PATCH {endpoint}/api/tasks/{external_id} { status: "done" }
    console.log(`[beads:${this.id}] close() stub for ${task.external_id}`);
  }

  async health() {
    if (!this.endpoint || !this.token) return { ok: false, message: 'missing endpoint or token' };
    // TODO: GET {endpoint}/api/health
    return { ok: true, message: 'stub (not verified)' };
  }
}
