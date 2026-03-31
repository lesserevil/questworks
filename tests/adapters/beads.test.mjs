/**
 * tests/adapters/beads.test.mjs
 *
 * Unit tests for adapters/beads.mjs using Node's built-in test runner.
 * Mocks globalThis.fetch to avoid real network calls.
 *
 * Run: node --test tests/adapters/beads.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeadsAdapter } from '../../adapters/beads.mjs';
import { AdapterError } from '../../adapters/http.mjs';

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

function mockResponse(status, body, headers = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => JSON.parse(bodyStr),
    text: async () => bodyStr,
  };
}

function installFetchMock(responses) {
  let callCount = 0;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const resp = responses[callCount];
    callCount++;
    if (!resp) throw new Error(`Unexpected fetch call #${callCount} to ${url}`);
    if (resp instanceof Error) throw resp;
    return resp;
  };
  return {
    restore: () => { globalThis.fetch = original; },
    calls,
  };
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeAdapter(config = {}) {
  return new BeadsAdapter('test-beads', {
    endpoint: 'https://beads.example.com',
    token: 'test-token',
    board_id: 'board-1',
    ...config,
  });
}

function makeRawTask(overrides = {}) {
  return {
    id: 'task-42',
    title: 'Do the thing',
    description: 'Details here',
    tags: ['backend', 'urgent'],
    priority: 2,
    ...overrides,
  };
}

function makeQwTask(overrides = {}) {
  return {
    external_id: 'task-42',
    assignee: 'jonny',
    ...overrides,
  };
}

// ─── pull() tests ─────────────────────────────────────────────────────────────

test('pull() returns [] and makes no API call when endpoint missing', async () => {
  const mock = installFetchMock([]);
  const adapter = makeAdapter({ endpoint: '' });
  const result = await adapter.pull();
  assert.deepEqual(result, []);
  assert.equal(mock.calls.length, 0, 'no fetch calls expected');
  mock.restore();
});

test('pull() returns [] and makes no API call when token missing', async () => {
  const mock = installFetchMock([]);
  const adapter = makeAdapter({ token: '' });
  const result = await adapter.pull();
  assert.deepEqual(result, []);
  assert.equal(mock.calls.length, 0);
  mock.restore();
});

test('pull() returns [] and makes no API call when board_id missing', async () => {
  const mock = installFetchMock([]);
  const adapter = makeAdapter({ board_id: '' });
  const result = await adapter.pull();
  assert.deepEqual(result, []);
  assert.equal(mock.calls.length, 0);
  mock.restore();
});

test('pull() returns normalized tasks from a single page', async () => {
  const raw = makeRawTask();
  const mock = installFetchMock([
    mockResponse(200, { tasks: [raw] }),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.equal(result.length, 1);
  assert.equal(result[0].external_id, 'task-42');
  assert.equal(result[0].title, 'Do the thing');
  assert.equal(result[0].description, 'Details here');
  assert.deepEqual(result[0].labels, ['backend', 'urgent']);
  assert.equal(result[0].priority, 2);
  assert.equal(result[0].source, 'test-beads');
  assert.equal(result[0].external_url, 'https://beads.example.com/boards/board-1/tasks/task-42');
  assert.equal(result[0].metadata.beads_board_id, 'board-1');
  assert.equal(result[0].metadata.beads_task_id, 'task-42');
  assert.equal(result[0].status, 'open');
  mock.restore();
});

test('pull() falls back to labels field when tags is absent', async () => {
  const raw = makeRawTask({ tags: undefined, labels: ['infra'] });
  const mock = installFetchMock([
    mockResponse(200, { tasks: [raw] }),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.deepEqual(result[0].labels, ['infra']);
  mock.restore();
});

test('pull() prefers tags over labels when both present', async () => {
  const raw = makeRawTask({ tags: ['tag-a'], labels: ['label-b'] });
  const mock = installFetchMock([
    mockResponse(200, { tasks: [raw] }),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.deepEqual(result[0].labels, ['tag-a']);
  mock.restore();
});

test('pull() defaults priority to 0 when not numeric', async () => {
  const raw = makeRawTask({ priority: 'high' });
  const mock = installFetchMock([
    mockResponse(200, { tasks: [raw] }),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.equal(result[0].priority, 0);
  mock.restore();
});

test('pull() trims description to 4000 characters', async () => {
  const long = 'x'.repeat(5000);
  const raw = makeRawTask({ description: long });
  const mock = installFetchMock([
    mockResponse(200, { tasks: [raw] }),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.equal(result[0].description.length, 4000);
  mock.restore();
});

test('pull() handles array response (no wrapper object)', async () => {
  const raw = makeRawTask();
  const mock = installFetchMock([
    mockResponse(200, [raw]),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.equal(result.length, 1);
  mock.restore();
});

test('pull() follows next_cursor pagination', async () => {
  const raw1 = makeRawTask({ id: 'task-1', title: 'First' });
  const raw2 = makeRawTask({ id: 'task-2', title: 'Second' });
  const mock = installFetchMock([
    mockResponse(200, { tasks: [raw1], next_cursor: 'abc123' }),
    mockResponse(200, { tasks: [raw2] }),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.equal(result.length, 2);
  assert.equal(result[0].external_id, 'task-1');
  assert.equal(result[1].external_id, 'task-2');
  assert.ok(mock.calls[1].url.includes('cursor=abc123'));
  mock.restore();
});

test('pull() follows next_url pagination', async () => {
  const raw1 = makeRawTask({ id: 'task-1', title: 'First' });
  const raw2 = makeRawTask({ id: 'task-2', title: 'Second' });
  const mock = installFetchMock([
    mockResponse(200, { tasks: [raw1], next_url: 'https://beads.example.com/api/boards/board-1/tasks?status=open&page=2' }),
    mockResponse(200, { tasks: [raw2] }),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.equal(result.length, 2);
  assert.equal(mock.calls[1].url, 'https://beads.example.com/api/boards/board-1/tasks?status=open&page=2');
  mock.restore();
});

test('pull() returns [] on empty tasks array', async () => {
  const mock = installFetchMock([
    mockResponse(200, { tasks: [] }),
  ]);
  const adapter = makeAdapter();
  const result = await adapter.pull();
  assert.deepEqual(result, []);
  mock.restore();
});

test('pull() throws AdapterError on HTTP failure', async () => {
  const mock = installFetchMock([
    mockResponse(500, 'Internal Server Error'),
  ]);
  const adapter = makeAdapter();
  await assert.rejects(() => adapter.pull(), AdapterError);
  mock.restore();
});

test('pull() sends Bearer auth header', async () => {
  const raw = makeRawTask();
  const mock = installFetchMock([
    mockResponse(200, { tasks: [raw] }),
  ]);
  const adapter = makeAdapter();
  await adapter.pull();
  assert.ok(mock.calls[0].opts?.headers?.Authorization?.startsWith('Bearer '), 'should send Bearer auth');
  mock.restore();
});

// ─── claim() tests ────────────────────────────────────────────────────────────

test('claim() sends correct PATCH body', async () => {
  const mock = installFetchMock([mockResponse(200, {})]);
  const adapter = makeAdapter();
  const task = makeQwTask();
  const result = await adapter.claim(task);
  assert.equal(result, true);
  const body = JSON.parse(mock.calls[0].opts.body);
  assert.equal(body.status, 'claimed');
  assert.equal(body.assignee, 'jonny');
  mock.restore();
});

test('claim() sends PATCH to correct URL', async () => {
  const mock = installFetchMock([mockResponse(200, {})]);
  const adapter = makeAdapter();
  await adapter.claim(makeQwTask());
  assert.equal(mock.calls[0].url, 'https://beads.example.com/api/tasks/task-42');
  mock.restore();
});

test('claim() returns false on 409 (already claimed)', async () => {
  const mock = installFetchMock([mockResponse(409, 'Conflict')]);
  const adapter = makeAdapter();
  const result = await adapter.claim(makeQwTask());
  assert.equal(result, false);
  mock.restore();
});

test('claim() throws AdapterError on non-409 failure', async () => {
  const mock = installFetchMock([mockResponse(500, 'Server Error')]);
  const adapter = makeAdapter();
  await assert.rejects(() => adapter.claim(makeQwTask()), AdapterError);
  mock.restore();
});

// ─── update() tests ───────────────────────────────────────────────────────────

test('update() sends single PATCH with both status and comment', async () => {
  const mock = installFetchMock([mockResponse(200, {})]);
  const adapter = makeAdapter();
  await adapter.update(makeQwTask(), { status: 'in_progress', comment: 'Working on it' });
  assert.equal(mock.calls.length, 1, 'should send exactly one PATCH');
  const body = JSON.parse(mock.calls[0].opts.body);
  assert.equal(body.status, 'in_progress');
  assert.equal(body.comment, 'Working on it');
  mock.restore();
});

test('update() sends PATCH with only status when comment absent', async () => {
  const mock = installFetchMock([mockResponse(200, {})]);
  const adapter = makeAdapter();
  await adapter.update(makeQwTask(), { status: 'review' });
  const body = JSON.parse(mock.calls[0].opts.body);
  assert.equal(body.status, 'review');
  assert.equal(body.comment, undefined);
  mock.restore();
});

test('update() sends PATCH with only comment when status absent', async () => {
  const mock = installFetchMock([mockResponse(200, {})]);
  const adapter = makeAdapter();
  await adapter.update(makeQwTask(), { comment: 'Note added' });
  const body = JSON.parse(mock.calls[0].opts.body);
  assert.equal(body.comment, 'Note added');
  assert.equal(body.status, undefined);
  mock.restore();
});

test('update() makes no API call when changes is empty', async () => {
  const mock = installFetchMock([]);
  const adapter = makeAdapter();
  await adapter.update(makeQwTask(), {});
  assert.equal(mock.calls.length, 0);
  mock.restore();
});

test('update() throws AdapterError on HTTP failure', async () => {
  const mock = installFetchMock([mockResponse(500, 'Error')]);
  const adapter = makeAdapter();
  await assert.rejects(() => adapter.update(makeQwTask(), { status: 'done' }), AdapterError);
  mock.restore();
});

// ─── close() tests ────────────────────────────────────────────────────────────

test('close() sends PATCH with status done', async () => {
  const mock = installFetchMock([mockResponse(200, {})]);
  const adapter = makeAdapter();
  await adapter.close(makeQwTask());
  const body = JSON.parse(mock.calls[0].opts.body);
  assert.equal(body.status, 'done');
  mock.restore();
});

test('close() does not throw on 404 (task already gone)', async () => {
  const mock = installFetchMock([mockResponse(404, 'Not Found')]);
  const adapter = makeAdapter();
  await assert.doesNotReject(() => adapter.close(makeQwTask()));
  mock.restore();
});

test('close() throws AdapterError on non-404 failure', async () => {
  const mock = installFetchMock([mockResponse(500, 'Error')]);
  const adapter = makeAdapter();
  await assert.rejects(() => adapter.close(makeQwTask()), AdapterError);
  mock.restore();
});

// ─── health() tests ───────────────────────────────────────────────────────────

test('health() returns ok:false when endpoint missing', async () => {
  const adapter = makeAdapter({ endpoint: '' });
  const result = await adapter.health();
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('missing'));
});

test('health() returns ok:false when token missing', async () => {
  const adapter = makeAdapter({ token: '' });
  const result = await adapter.health();
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('missing'));
});

test('health() returns ok:true with endpoint info on 200', async () => {
  const mock = installFetchMock([mockResponse(200, { status: 'ok' })]);
  const adapter = makeAdapter();
  const result = await adapter.health();
  assert.equal(result.ok, true);
  assert.ok(result.message.includes('beads.example.com'));
  mock.restore();
});

test('health() returns ok:false with message on 401', async () => {
  const mock = installFetchMock([mockResponse(401, 'Unauthorized')]);
  const adapter = makeAdapter();
  const result = await adapter.health();
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('token'));
  mock.restore();
});

test('health() returns ok:false on network error without throwing', async () => {
  const mock = installFetchMock([new Error('Connection refused')]);
  const adapter = makeAdapter();
  const result = await adapter.health();
  assert.equal(result.ok, false);
  assert.ok(typeof result.message === 'string');
  mock.restore();
});

test('health() never throws on 5xx error', async () => {
  const mock = installFetchMock([mockResponse(503, 'Service Unavailable')]);
  const adapter = makeAdapter();
  await assert.doesNotReject(() => adapter.health());
  mock.restore();
});

test('health() sends GET to /api/health', async () => {
  const mock = installFetchMock([mockResponse(200, {})]);
  const adapter = makeAdapter();
  await adapter.health();
  assert.equal(mock.calls[0].url, 'https://beads.example.com/api/health');
  mock.restore();
});

test('health() sends Bearer auth header', async () => {
  const mock = installFetchMock([mockResponse(200, {})]);
  const adapter = makeAdapter();
  await adapter.health();
  assert.ok(mock.calls[0].opts?.headers?.Authorization?.startsWith('Bearer '));
  mock.restore();
});
