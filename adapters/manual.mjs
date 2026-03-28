import { BaseAdapter } from './base.mjs';

/**
 * Manual adapter — tasks added directly via /qw task add manual.
 * No external system to sync with; all operations are no-ops.
 */
export class ManualAdapter extends BaseAdapter {
  constructor(id, config) {
    super(id, config);
  }

  async pull() { return []; }
  async claim(task) { return true; }
  async update(task, changes) {}
  async close(task) {}
  async health() { return { ok: true, message: 'manual adapter (no external system)' }; }
}
