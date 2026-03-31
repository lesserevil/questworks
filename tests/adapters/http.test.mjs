/**
 * tests/adapters/http.test.mjs
 *
 * Unit tests for adapters/http.mjs using Node's built-in test runner.
 * Mocks globalThis.fetch to avoid real network calls.
 *
 * Run: node --test tests/adapters/http.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, AdapterError, bearerAuth, basicAuth } from '../../adapters/http.mjs';

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

function mockResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

function installFetchMock(responses) {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => {
    const resp = responses[callCount];
    callCount++;
    if (!resp) throw new Error('Unexpected fetch call');
    if (resp instanceof Error) throw resp;
    return resp;
  };
  return () => {
    globalThis.fetch = original;
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('T1: 200 response returns parsed JSON', async () => {
  const restore = installFetchMock([
    mockResponse(200, JSON.stringify({ ok: true, value: 42 })),
  ]);
  try {
    const result = await fetchJson('https://example.com/api');
    assert.deepEqual(result, { ok: true, value: 42 });
  } finally {
    restore();
  }
});

test('T2: 404 throws AdapterError with status=404', async () => {
  const restore = installFetchMock([
    mockResponse(404, 'Not found'),
  ]);
  try {
    await assert.rejects(
      () => fetchJson('https://example.com/api'),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.status, 404);
        assert.equal(err.name, 'AdapterError');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('T3: network error (fetch throws) results in AdapterError with status=0', async () => {
  const restore = installFetchMock([new Error('ECONNREFUSED')]);
  try {
    await assert.rejects(
      () => fetchJson('https://example.com/api'),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.status, 0);
        assert.equal(err.message, 'ECONNREFUSED');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('T4: 429 with Retry-After: 1 retries once and returns JSON on second call', async () => {
  const restore = installFetchMock([
    mockResponse(429, 'rate limited', { 'retry-after': '1' }),
    mockResponse(200, JSON.stringify({ retried: true })),
  ]);
  try {
    // Speed up the sleep for testing
    const result = await fetchJson('https://example.com/api');
    assert.deepEqual(result, { retried: true });
  } finally {
    restore();
  }
});

test('T5: 429 with Retry-After: 120 throws without retrying', async () => {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return mockResponse(429, 'rate limited', { 'retry-after': '120' });
  };
  try {
    await assert.rejects(
      () => fetchJson('https://example.com/api'),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.status, 429);
        return true;
      },
    );
    assert.equal(callCount, 1, 'Should only call fetch once (no retry)');
  } finally {
    globalThis.fetch = original;
  }
});

test('T6: bearerAuth returns { Authorization: "Bearer tok" }', () => {
  const headers = bearerAuth('tok');
  assert.deepEqual(headers, { Authorization: 'Bearer tok' });
});

test('T7: basicAuth returns correct base64 Basic auth header', () => {
  const headers = basicAuth('user@example.com', 'secret123');
  const expected = Buffer.from('user@example.com:secret123').toString('base64');
  assert.deepEqual(headers, { Authorization: `Basic ${expected}` });
});

test('T8: AdapterError has correct properties', () => {
  const err = new AdapterError('something went wrong', 503, 'Service Unavailable');
  assert.equal(err.name, 'AdapterError');
  assert.equal(err.status, 503);
  assert.equal(err.body, 'Service Unavailable');
  assert.equal(err.message, 'something went wrong');
  assert.ok(err instanceof Error);
});

test('T9: retryOn429=false does not retry on 429', async () => {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return mockResponse(429, 'rate limited', { 'retry-after': '1' });
  };
  try {
    await assert.rejects(
      () => fetchJson('https://example.com/api', { retryOn429: false }),
      (err) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.status, 429);
        return true;
      },
    );
    assert.equal(callCount, 1, 'Should only call fetch once when retryOn429=false');
  } finally {
    globalThis.fetch = original;
  }
});
