/**
 * tests/routes/routes.test.mjs
 *
 * Integration tests for the QuestWorks REST API routes.
 * Covers task full lifecycle, adapter detail, edge cases, and auth failures.
 *
 * Spins up an in-process Express server with an in-memory SQLite DB.
 * No live server or network access required.
 *
 * Run: node --test tests/routes/routes.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { SqliteDb } from '../../db/sqlite.mjs';
import { createTaskRoutes } from '../../routes/tasks.mjs';
import { createAdapterRoutes } from '../../routes/adapters.mjs';

// ── Test server setup ─────────────────────────────────────────────────────────

const TEST_TOKEN = 'test-token-abc123';

function makeDb() {
  const db = new SqliteDb(':memory:');
  db.applySchema();
  return db;
}

/** Minimal adapter stub for in-memory registry tests */
class StubAdapter {
  constructor(id) { this.id = id; }
  async health() { return { ok: true, message: 'stub' }; }
}

function buildApp(db, adapterRegistry) {
  const app = express();
  app.use(express.json());

  // Auth middleware (mirrors server.mjs)
  app.use((req, res, next) => {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '').trim();
    if (token !== TEST_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.use('/tasks', createTaskRoutes(db, null, adapterRegistry));
  app.use('/adapters', createAdapterRoutes(db, adapterRegistry, null));
  return app;
}

let server;
let baseUrl;
let db;
let adapterRegistry;

before(async () => {
  db = makeDb();
  adapterRegistry = new Map();
  adapterRegistry.set('adapter-1', new StubAdapter('adapter-1'));

  const app = buildApp(db, adapterRegistry);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function req(method, path, { body, auth = true } = {}) {
  const url = new URL(path, baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = `Bearer ${TEST_TOKEN}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('Auth', () => {
  test('GET /tasks without token → 401', async () => {
    const r = await req('GET', '/tasks', { auth: false });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
  });

  test('GET /adapters without token → 401', async () => {
    const r = await req('GET', '/adapters', { auth: false });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
  });

  test('POST /tasks without token → 401', async () => {
    const r = await req('POST', '/tasks', { auth: false, body: { title: 'x' } });
    assert.equal(r.status, 401);
  });
});

// ── Task lifecycle ────────────────────────────────────────────────────────────

describe('Task lifecycle', () => {
  let taskId;

  test('POST /tasks creates a task', async () => {
    const r = await req('POST', '/tasks', {
      body: { title: 'Integration test task', description: 'Test description', priority: 2 },
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.id, 'response should include id');
    assert.equal(r.body.title, 'Integration test task');
    assert.equal(r.body.status, 'open');
    assert.equal(r.body.priority, 2);
    taskId = r.body.id;
  });

  test('GET /tasks lists tasks including the new one', async () => {
    const r = await req('GET', '/tasks');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    const found = r.body.find(t => t.id === taskId);
    assert.ok(found, 'created task should appear in list');
  });

  test('GET /tasks/:id returns the task', async () => {
    const r = await req('GET', `/tasks/${taskId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, taskId);
    assert.equal(r.body.title, 'Integration test task');
  });

  test('PATCH /tasks/:id updates allowed fields', async () => {
    const r = await req('PATCH', `/tasks/${taskId}`, {
      body: { priority: 5, assignee: 'jonny', labels: ['bug', 'urgent'] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.priority, 5);
    assert.equal(r.body.assignee, 'jonny');
    assert.deepEqual(r.body.labels, ['bug', 'urgent']);
  });

  test('GET /tasks/:id reflects the update', async () => {
    const r = await req('GET', `/tasks/${taskId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.priority, 5);
    assert.equal(r.body.assignee, 'jonny');
  });

  test('DELETE /tasks/:id removes the task', async () => {
    const r = await req('DELETE', `/tasks/${taskId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.id, taskId);
  });

  test('GET /tasks/:id returns 404 after deletion', async () => {
    const r = await req('GET', `/tasks/${taskId}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not found');
  });

  test('GET /tasks no longer contains deleted task', async () => {
    const r = await req('GET', '/tasks');
    assert.equal(r.status, 200);
    const found = r.body.find(t => t.id === taskId);
    assert.ok(!found, 'deleted task should not appear in list');
  });
});

// ── PATCH edge cases ──────────────────────────────────────────────────────────

describe('PATCH /tasks/:id edge cases', () => {
  let taskId;

  before(async () => {
    const r = await req('POST', '/tasks', { body: { title: 'Patch edge case task' } });
    taskId = r.body.id;
  });

  test('PATCH with no valid fields → 400', async () => {
    const r = await req('PATCH', `/tasks/${taskId}`, { body: { status: 'done' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no valid fields/);
  });

  test('PATCH with metadata as object serializes correctly', async () => {
    const r = await req('PATCH', `/tasks/${taskId}`, {
      body: { metadata: { jira_key: 'PROJ-42', sprint: 3 } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.metadata, { jira_key: 'PROJ-42', sprint: 3 });
  });

  test('PATCH /tasks/nonexistent → 404', async () => {
    const r = await req('PATCH', '/tasks/does-not-exist', { body: { priority: 1 } });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not found');
  });
});

// ── DELETE edge cases ─────────────────────────────────────────────────────────

describe('DELETE /tasks/:id edge cases', () => {
  test('DELETE /tasks/nonexistent → 404', async () => {
    const r = await req('DELETE', '/tasks/does-not-exist');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not found');
  });
});

// ── POST /tasks edge cases ────────────────────────────────────────────────────

describe('POST /tasks edge cases', () => {
  test('POST /tasks without title → 400', async () => {
    const r = await req('POST', '/tasks', { body: { description: 'no title here' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /title/);
  });

  test('POST /tasks with empty title → 400', async () => {
    const r = await req('POST', '/tasks', { body: { title: '   ' } });
    assert.equal(r.status, 400);
  });
});

// ── Adapter detail ────────────────────────────────────────────────────────────

describe('Adapter detail', () => {
  test('GET /adapters returns array with stub adapter', async () => {
    const r = await req('GET', '/adapters');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    const a = r.body.find(x => x.id === 'adapter-1');
    assert.ok(a, 'stub adapter should appear in list');
    assert.equal(a.health.ok, true);
  });

  test('GET /adapters/:id returns adapter detail', async () => {
    const r = await req('GET', '/adapters/adapter-1');
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'adapter-1');
    assert.equal(r.body.health.ok, true);
  });

  test('GET /adapters/:id with unknown id → 404', async () => {
    const r = await req('GET', '/adapters/no-such-adapter');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'adapter not found');
  });

  test('GET /adapters/:id without token → 401', async () => {
    const r = await req('GET', '/adapters/adapter-1', { auth: false });
    assert.equal(r.status, 401);
  });
});
