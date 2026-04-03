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

      // Upsert all tasks in a single transaction
      const newTaskIds = await this.db.transaction(async (txDb) => {
        const newIds = [];
        for (const task of tasks) {
          const existing = await txDb.queryOne(
            'SELECT id FROM tasks WHERE source=? AND external_id=?',
            [task.source, task.external_id]
          );

          const serialized = {
            ...task,
            labels: JSON.stringify(task.labels || []),
            metadata: JSON.stringify(task.metadata || {}),
          };

          await txDb.run(`
            INSERT INTO tasks (id, title, description, status, assignee, claimed_at, source, external_id, external_url, labels, priority, created_at, updated_at, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, external_id) DO UPDATE SET
              title=excluded.title,
              description=excluded.description,
              external_url=excluded.external_url,
              labels=excluded.labels,
              priority=excluded.priority,
              updated_at=excluded.updated_at,
              metadata=excluded.metadata
            WHERE tasks.status = 'open'
          `, [
            serialized.id, serialized.title, serialized.description,
            serialized.status, serialized.assignee, serialized.claimed_at,
            serialized.source, serialized.external_id, serialized.external_url,
            serialized.labels, serialized.priority,
            serialized.created_at, serialized.updated_at, serialized.metadata,
          ]);

          if (!existing) newIds.push({ source: task.source, external_id: task.external_id });
        }
        return newIds;
      });

      count = tasks.length;

      // Notify for genuinely new tasks (those that weren't in DB before upsert)
      if (this.notifier && newTaskIds.length > 0) {
        for (const { source, external_id } of newTaskIds) {
          const row = await this.db.queryOne(
            'SELECT * FROM tasks WHERE source=? AND external_id=?',
            [source, external_id]
          );
          if (!row) continue;

          const deserialized = {
            ...row,
            labels: typeof row.labels === 'string' ? JSON.parse(row.labels || '[]') : (row.labels ?? []),
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata ?? {}),
          };

          // Skip if we already have a Mattermost post for this task
          if (deserialized.metadata.mm_post_id) continue;

          this.notifier.onNewTask(deserialized)
            .then(async (postId) => {
              if (postId) {
                const meta = { ...deserialized.metadata, mm_post_id: postId };
                await this.db.run(
                  'UPDATE tasks SET metadata=?, updated_at=? WHERE id=?',
                  [JSON.stringify(meta), new Date().toISOString(), row.id]
                );
              }
            })
            .catch(err => console.error('[notify] new task failed:', err));
        }
      }

      await this.db.run(
        `INSERT INTO adapter_state (adapter_id, last_sync, task_count, status) VALUES (?, ?, ?, 'ok')
         ON CONFLICT (adapter_id) DO UPDATE SET last_sync=excluded.last_sync, task_count=excluded.task_count, status=excluded.status, last_error=NULL`,
        [adapterId, now, count]
      );

    } catch (err) {
      await this.db.run(
        `INSERT INTO adapter_state (adapter_id, last_sync, last_error, status) VALUES (?, ?, ?, 'error')
         ON CONFLICT (adapter_id) DO UPDATE SET last_sync=excluded.last_sync, last_error=excluded.last_error, status=excluded.status`,
        [adapterId, now, err.message]
      );
      throw err;
    }

    return count;
  }
}
