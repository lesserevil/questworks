/**
 * Base adapter class — all adapters must implement these methods.
 * Adapters are the bridge between QuestWorks and external task systems.
 */
export class BaseAdapter {
  constructor(id, config) {
    this.id = id;
    this.config = config;
  }

  /**
   * Fetch new/updated tasks from source system.
   * @returns {Promise<Task[]>}
   */
  async pull() {
    throw new Error(`${this.constructor.name}.pull() not implemented`);
  }

  /**
   * Mark a task as claimed in the source system.
   * @param {object} task - QuestWorks task object
   * @returns {Promise<boolean>} true if claim succeeded
   */
  async claim(task) {
    throw new Error(`${this.constructor.name}.claim() not implemented`);
  }

  /**
   * Push status/comment back to source system.
   * @param {object} task - QuestWorks task object
   * @param {object} changes - { status?, comment? }
   */
  async update(task, changes) {
    throw new Error(`${this.constructor.name}.update() not implemented`);
  }

  /**
   * Mark task as done in the source system.
   * @param {object} task - QuestWorks task object
   */
  async close(task) {
    throw new Error(`${this.constructor.name}.close() not implemented`);
  }

  /**
   * Health check — return { ok: bool, message: string }
   */
  async health() {
    return { ok: true, message: 'stub' };
  }
}

/**
 * Normalize a raw source task into QuestWorks task shape.
 * Adapters should call this before returning from pull().
 */
export function normalizeTask({ id, source, externalId, externalUrl, title, description, labels = [], priority = 0, metadata = {} }) {
  const now = new Date().toISOString();
  return {
    id,
    title,
    description: description || '',
    status: 'open',
    assignee: null,
    claimed_at: null,
    source,
    external_id: externalId,
    external_url: externalUrl || null,
    labels: Array.isArray(labels) ? labels : [],
    priority,
    created_at: now,
    updated_at: now,
    metadata: metadata || {},
  };
}
