/**
 * tests/adapters/github.test.mjs
 *
 * Unit tests for adapters/github.mjs using Node's built-in test runner.
 * Mocks globalThis.fetch to avoid real network calls.
 *
 * Run: node --test tests/adapters/github.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAdapter } from '../../adapters/github.mjs';
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

let fetchCalls = [];
let fetchResponses = [];
let originalFetch;

function installFetchMock(responses) {
  fetchCalls = [];
  fetchResponses = [...responses];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (fetchResponses.length === 0) {
      throw new Error('No mock response available for: ' + url);
    }
    const next = fetchResponses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  fetchCalls = [];
  fetchResponses = [];
}

// ─── Sample data ─────────────────────────────────────────────────────────────

function makeIssue(overrides = {}) {
  return {
    number: 42,
    node_id: 'MDU6SXNzdWU0Mg==',
    html_url: 'https://github.com/owner/repo/issues/42',
    title: 'Test issue',
    body: 'Issue body text',
    labels: [{ name: 'questworks' }, { name: 'bug' }],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GitHubAdapter', () => {

  describe('pull()', () => {
    afterEach(restoreFetch);

    test('T1: returns [] when label_filter not set (no API call)', async () => {
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      const result = await adapter.pull();
      assert.deepEqual(result, []);
      assert.equal(fetchCalls.length, 0, 'no fetch calls should be made');
    });

    test('T2: returns normalized tasks for matching open issues', async () => {
      const issue = makeIssue();
      installFetchMock([
        mockResponse(200, [issue]),
      ]);
      const adapter = new GitHubAdapter('gh', {
        repo: 'owner/repo',
        token: 'tok',
        label_filter: 'questworks',
      });
      const tasks = await adapter.pull();
      assert.equal(tasks.length, 1);
      const t = tasks[0];
      assert.equal(t.external_id, '42');
      assert.equal(t.external_url, 'https://github.com/owner/repo/issues/42');
      assert.equal(t.title, 'Test issue');
      assert.equal(t.description, 'Issue body text');
      assert.deepEqual(t.labels, ['questworks', 'bug']);
      assert.equal(t.priority, 0);
      assert.equal(t.source, 'gh');
      assert.equal(t.metadata.github_number, 42);
      assert.equal(t.metadata.github_node_id, 'MDU6SXNzdWU0Mg==');
    });

    test('T3: follows pagination via Link header', async () => {
      const page1 = [makeIssue({ number: 1 })];
      const page2 = [makeIssue({ number: 2 })];
      installFetchMock([
        mockResponse(200, page1, {
          link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"',
        }),
        mockResponse(200, page2),
      ]);
      const adapter = new GitHubAdapter('gh', {
        repo: 'owner/repo',
        token: 'tok',
        label_filter: 'questworks',
      });
      const tasks = await adapter.pull();
      assert.equal(tasks.length, 2);
      assert.equal(fetchCalls.length, 2);
    });

    test('T4: throws AdapterError on HTTP error', async () => {
      installFetchMock([mockResponse(500, 'Internal Server Error')]);
      const adapter = new GitHubAdapter('gh', {
        repo: 'owner/repo',
        token: 'tok',
        label_filter: 'questworks',
      });
      await assert.rejects(() => adapter.pull(), AdapterError);
    });

    test('T5: trims description to 4000 chars', async () => {
      const longBody = 'x'.repeat(5000);
      const issue = makeIssue({ body: longBody });
      installFetchMock([mockResponse(200, [issue])]);
      const adapter = new GitHubAdapter('gh', {
        repo: 'owner/repo',
        token: 'tok',
        label_filter: 'questworks',
      });
      const tasks = await adapter.pull();
      assert.equal(tasks[0].description.length, 4000);
    });

    test('T6: handles null issue body gracefully', async () => {
      const issue = makeIssue({ body: null });
      installFetchMock([mockResponse(200, [issue])]);
      const adapter = new GitHubAdapter('gh', {
        repo: 'owner/repo',
        token: 'tok',
        label_filter: 'questworks',
      });
      const tasks = await adapter.pull();
      assert.equal(tasks[0].description, '');
    });
  });

  describe('claim()', () => {
    afterEach(restoreFetch);

    test('T7: posts a comment containing the assignee name', async () => {
      installFetchMock([mockResponse(201, { id: 1, body: '...' })]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      const task = { external_id: '42', assignee: 'race-bannon' };
      const result = await adapter.claim(task);
      assert.equal(result, true);
      const body = JSON.parse(fetchCalls[0].opts.body);
      assert.match(body.body, /race-bannon/);
    });

    test('T8: returns true even when comment POST fails (fire-and-forget)', async () => {
      installFetchMock([mockResponse(422, 'Unprocessable Entity')]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      const task = { external_id: '42', assignee: 'jonny' };
      // Should NOT throw
      const result = await adapter.claim(task);
      assert.equal(result, true);
    });
  });

  describe('update()', () => {
    afterEach(restoreFetch);

    test('T9: posts a single comment when both status and comment provided', async () => {
      installFetchMock([mockResponse(201, { id: 2 })]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      const task = { external_id: '42', assignee: 'jonny' };
      await adapter.update(task, { status: 'in_progress', comment: 'Working on it' });
      assert.equal(fetchCalls.length, 1, 'only one comment should be posted');
      const body = JSON.parse(fetchCalls[0].opts.body);
      assert.match(body.body, /Working on it/);
      assert.match(body.body, /in_progress/);
    });

    test('T10: posts only comment text when status not provided', async () => {
      installFetchMock([mockResponse(201, { id: 2 })]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      await adapter.update({ external_id: '42' }, { comment: 'Just a comment' });
      const body = JSON.parse(fetchCalls[0].opts.body);
      assert.equal(body.body, 'Just a comment');
    });

    test('T11: posts status note when only status provided', async () => {
      installFetchMock([mockResponse(201, { id: 2 })]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      await adapter.update({ external_id: '42' }, { status: 'review' });
      const body = JSON.parse(fetchCalls[0].opts.body);
      assert.equal(body.body, 'Status → review');
    });

    test('T12: does nothing when changes is empty', async () => {
      fetchCalls = []; // no mock installed — ensure counter is clean
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      await adapter.update({ external_id: '42' }, {});
      assert.equal(fetchCalls.length, 0);
    });
  });

  describe('close()', () => {
    afterEach(restoreFetch);

    test('T13: patches issue to closed and posts completion comment', async () => {
      installFetchMock([
        mockResponse(200, { number: 42, state: 'closed' }),  // PATCH
        mockResponse(201, { id: 3 }),                         // POST comment
      ]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      await adapter.close({ external_id: '42', assignee: 'jonny' });
      assert.equal(fetchCalls.length, 2);
      const patchBody = JSON.parse(fetchCalls[0].opts.body);
      assert.equal(patchBody.state, 'closed');
      const commentBody = JSON.parse(fetchCalls[1].opts.body);
      assert.match(commentBody.body, /jonny/);
    });

    test('T14: does not error when issue is already closed (404)', async () => {
      installFetchMock([
        mockResponse(404, 'Not Found'),       // PATCH — issue already closed
        mockResponse(201, { id: 3 }),          // POST comment still attempted
      ]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      // Should NOT throw
      await adapter.close({ external_id: '42', assignee: 'jonny' });
    });
  });

  describe('health()', () => {
    afterEach(restoreFetch);

    test('T15: returns { ok: false } when no token configured', async () => {
      fetchCalls = []; // no mock installed — ensure counter is clean
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo' });
      const result = await adapter.health();
      assert.equal(result.ok, false);
      assert.equal(fetchCalls.length, 0);
    });

    test('T16: returns { ok: true } with rate limit info on success', async () => {
      installFetchMock([
        mockResponse(200, { rate: { remaining: 4500, limit: 5000 } }),
      ]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      const result = await adapter.health();
      assert.equal(result.ok, true);
      assert.match(result.message, /4500\/5000/);
    });

    test('T17: returns { ok: false } with message on 401', async () => {
      installFetchMock([mockResponse(401, 'Unauthorized')]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'bad' });
      const result = await adapter.health();
      assert.equal(result.ok, false);
      assert.match(result.message, /invalid or expired/);
    });

    test('T18: never throws on any error', async () => {
      installFetchMock([new Error('network failure')]);
      const adapter = new GitHubAdapter('gh', { repo: 'owner/repo', token: 'tok' });
      const result = await adapter.health();
      assert.equal(result.ok, false);
      assert.match(result.message, /network failure/);
    });
  });

});
