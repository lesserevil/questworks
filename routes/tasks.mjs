import { Router } from 'express';
import { randomUUID } from 'crypto';

export function createTaskRoutes(db, notifier, adapters) {
  const router = Router();

  // GET /tasks — list with optional filters
  router.get('/', async (req, res) => {
    const { status, source, assignee } = req.query;
    let sql = 'SELECT * FROM tasks WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (source) { sql += ' AND source = ?'; params.push(source); }
    if (assignee) { sql += ' AND assignee = ?'; params.push(assignee); }
    sql += ' ORDER BY priority DESC, created_at DESC';
    const tasks = await db.query(sql, params);
    res.json(tasks.map(deserializeTask));
  });

  // GET /tasks/:id
  router.get('/:id', async (req, res) => {
    const task = await db.queryOne('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json(deserializeTask(task));
  });

  // POST /tasks/:id/claim — atomic claim
  router.post('/:id/claim', async (req, res) => {
    const { agent } = req.body;
    if (!agent) return res.status(400).json({ error: 'agent required' });

    let result;
    try {
      result = await db.transaction(async (txDb) => {
        const task = await txDb.queryOne('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
        if (!task) return { status: 404, body: { error: 'not found' } };
        if (task.status !== 'open' || task.assignee) {
          return { status: 409, body: { error: 'already claimed', assignee: task.assignee, status: task.status } };
        }
        const now = new Date().toISOString();
        await txDb.run(
          `UPDATE tasks SET status='claimed', assignee=?, claimed_at=?, updated_at=? WHERE id=?`,
          [agent, now, now, task.id]
        );
        await recordHistory(txDb, task.id, agent, 'claim', null, agent);
        const updated = await txDb.queryOne('SELECT * FROM tasks WHERE id = ?', [task.id]);
        return { status: 200, body: deserializeTask(updated) };
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    if (result.status === 200 && notifier) {
      notifier.onClaimed(result.body).catch(err => console.error('[notify] claim failed:', err));
    }
    res.status(result.status).json(result.body);
  });

  // POST /tasks/:id/unclaim
  router.post('/:id/unclaim', async (req, res) => {
    const task = await db.queryOne('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'not found' });
    const now = new Date().toISOString();
    await db.run(
      `UPDATE tasks SET status='open', assignee=NULL, claimed_at=NULL, updated_at=? WHERE id=?`,
      [now, task.id]
    );
    await recordHistory(db, task.id, req.body.agent, 'unclaim', task.assignee, null);
    const updated = await db.queryOne('SELECT * FROM tasks WHERE id = ?', [task.id]);
    res.json(deserializeTask(updated));
  });

  // POST /tasks/:id/status
  router.post('/:id/status', async (req, res) => {
    const { status, agent, comment } = req.body;
    const validStatuses = ['open', 'claimed', 'in_progress', 'review', 'done', 'blocked'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }
    const task = await db.queryOne('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'not found' });
    const now = new Date().toISOString();
    await db.run(`UPDATE tasks SET status=?, updated_at=? WHERE id=?`, [status, now, task.id]);
    await recordHistory(db, task.id, agent, 'status', task.status, status, comment);

    const updated = deserializeTask(await db.queryOne('SELECT * FROM tasks WHERE id = ?', [task.id]));
    const adapter = adapters.get(task.source);
    if (adapter && comment) {
      adapter.update(updated, { status, comment }).catch(err => console.error('[adapter] update failed:', err));
    }
    res.json(updated);
  });

  // POST /tasks/:id/complete
  router.post('/:id/complete', async (req, res) => {
    const { agent, comment } = req.body;
    const task = await db.queryOne('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'not found' });
    const now = new Date().toISOString();
    await db.run(`UPDATE tasks SET status='done', updated_at=? WHERE id=?`, [now, task.id]);
    await recordHistory(db, task.id, agent, 'complete', task.status, 'done', comment);

    const updated = deserializeTask(await db.queryOne('SELECT * FROM tasks WHERE id = ?', [task.id]));
    const adapter = adapters.get(task.source);
    if (adapter) {
      adapter.close(updated).catch(err => console.error('[adapter] close failed:', err));
    }
    if (notifier) {
      notifier.onCompleted(updated).catch(err => console.error('[notify] complete failed:', err));
    }
    res.json(updated);
  });

  // POST /tasks/:id/comment
  router.post('/:id/comment', async (req, res) => {
    const { agent, comment } = req.body;
    if (!comment) return res.status(400).json({ error: 'comment required' });
    const task = await db.queryOne('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'not found' });
    const now = new Date().toISOString();
    await db.run(`UPDATE tasks SET updated_at=? WHERE id=?`, [now, task.id]);
    await recordHistory(db, task.id, agent, 'comment', null, null, comment);

    const adapter = adapters.get(task.source);
    if (adapter) {
      adapter.update(deserializeTask(task), { comment }).catch(err => console.error('[adapter] comment failed:', err));
    }
    res.json({ ok: true });
  });

  // GET /tasks/:id/history
  router.get('/:id/history', async (req, res) => {
    const history = await db.query(
      'SELECT * FROM task_history WHERE task_id = ? ORDER BY ts DESC',
      [req.params.id]
    );
    res.json(history);
  });

  return router;
}

async function recordHistory(db, taskId, actor, action, oldValue, newValue, note) {
  await db.run(
    `INSERT INTO task_history (task_id, actor, action, old_value, new_value, note, ts) VALUES (?,?,?,?,?,?,?)`,
    [taskId, actor || null, action, oldValue ? String(oldValue) : null, newValue ? String(newValue) : null, note || null, new Date().toISOString()]
  );
}

function deserializeTask(row) {
  if (!row) return null;
  return {
    ...row,
    labels: typeof row.labels === 'string' ? JSON.parse(row.labels || '[]') : (row.labels ?? []),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata ?? {}),
  };
}
