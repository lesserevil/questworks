/**
 * Periodic sync scheduler — pulls tasks from all adapters on a configurable interval.
 */
export class SyncScheduler {
  constructor(db, adapterRegistry, notifier, intervalSeconds = 60) {
    this.db = db;
    this.adapters = adapterRegistry;
    this.notifier = notifier;
    this.interval = intervalSeconds * 1000;
    this._timer = null;
  }

  start() {
    console.log(`[scheduler] Starting sync every ${this.interval / 1000}s`);
    this._timer = setInterval(() => this.syncAll(), this.interval);
    // Run immediately on start
    this.syncAll();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async syncAll() {
    for (const [id] of this.adapters.entries()) {
      try {
        await this.syncAdapter(id);
      } catch (err) {
        console.error(`[scheduler] sync failed for ${id}:`, err.message);
      }
    }
  }

  async syncAdapter(adapterId) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`Adapter ${adapterId} not found`);

    const now = new Date().toISOString();
    let count = 0;

    try {
      const tasks = await adapter.pull();
      const upsert = this.db.prepare(`
        INSERT INTO tasks (id, title, description, status, assignee, claimed_at, source, external_id, external_url, labels, priority, created_at, updated_at, metadata)
        VALUES (@id, @title, @description, @status, @assignee, @claimed_at, @source, @external_id, @external_url, @labels, @priority, @created_at, @updated_at, @metadata)
        ON CONFLICT(source, external_id) DO UPDATE SET
          title=excluded.title,
          description=excluded.description,
          external_url=excluded.external_url,
          labels=excluded.labels,
          priority=excluded.priority,
          updated_at=excluded.updated_at,
          metadata=excluded.metadata
        WHERE tasks.status = 'open'
      `);

      const insertTx = this.db.transaction((taskList) => {
        let newCount = 0;
        for (const task of taskList) {
          const existing = this.db.prepare('SELECT id FROM tasks WHERE source=? AND external_id=?')
            .get(task.source, task.external_id);
          const serialized = {
            ...task,
            labels: JSON.stringify(task.labels || []),
            metadata: JSON.stringify(task.metadata || {}),
          };
          upsert.run(serialized);
          if (!existing) newCount++;
        }
        return newCount;
      });

      const newTasks = insertTx(tasks);
      count = tasks.length;

      // Notify for new tasks
      if (this.notifier && newTasks > 0) {
        for (const task of tasks) {
          const existing = this.db.prepare('SELECT id FROM tasks WHERE source=? AND external_id=?')
            .get(task.source, task.external_id);
          if (existing) {
            const fullTask = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(existing.id);
            if (fullTask) {
              this.notifier.onNewTask({
                ...fullTask,
                labels: JSON.parse(fullTask.labels || '[]'),
                metadata: JSON.parse(fullTask.metadata || '{}'),
              }).catch(err => console.error('[notify] new task failed:', err));
            }
          }
        }
      }

      this.db.prepare(`
        INSERT OR REPLACE INTO adapter_state (adapter_id, last_sync, task_count, status)
        VALUES (?, ?, ?, 'ok')
      `).run(adapterId, now, count);

    } catch (err) {
      this.db.prepare(`
        INSERT OR REPLACE INTO adapter_state (adapter_id, last_sync, last_error, status)
        VALUES (?, ?, ?, 'error')
      `).run(adapterId, now, err.message);
      throw err;
    }

    return count;
  }
}
