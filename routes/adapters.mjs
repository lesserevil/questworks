import { Router } from 'express';

export function createAdapterRoutes(db, adapterRegistry, scheduler) {
  const router = Router();

  // GET /adapters — list all with health
  router.get('/', async (req, res) => {
    const results = [];
    for (const [id, adapter] of adapterRegistry.entries()) {
      const state = await db.queryOne('SELECT * FROM adapter_state WHERE adapter_id = ?', [id]);
      let health;
      try {
        health = await adapter.health();
      } catch (err) {
        health = { ok: false, message: err.message };
      }
      results.push({
        id,
        type: adapter.constructor.name.replace('Adapter', '').toLowerCase(),
        health,
        last_sync: state?.last_sync || null,
        last_error: state?.last_error || null,
        task_count: state?.task_count || 0,
        status: state?.status || 'unknown',
      });
    }
    res.json(results);
  });

  // POST /adapters/:id/sync — manual pull
  router.post('/:id/sync', async (req, res) => {
    const adapter = adapterRegistry.get(req.params.id);
    if (!adapter) return res.status(404).json({ error: 'adapter not found' });
    try {
      const count = await scheduler.syncAdapter(req.params.id);
      res.json({ ok: true, tasks_upserted: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
