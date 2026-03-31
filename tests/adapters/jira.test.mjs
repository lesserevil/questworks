/**
 * tests/adapters/jira.test.mjs — Unit tests for adapters/jira.mjs
 *
 * Uses node:test + node:assert.
 * Mocking strategy: JiraAdapter accepts an optional `_http` injection
 * via its constructor (test seam). In production, it uses the real http module.
 * Tests T1–T12 per plans/jira-adapter.md.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JiraAdapter } from '/tmp/questworks-test/adapters/jira.mjs';
import { AdapterError } from '/tmp/questworks-test/adapters/http.mjs';

// --- Helpers ---

function makeAdapter(configOverrides = {}, fetchJsonImpl = async () => ({})) {
  const config = {
    url: 'https://test.atlassian.net',
    email: 'bot@example.com',
    token: 'secret-token',
    project: 'QUEST',
    jql: '',
    in_progress_transition: 'In Progress',
    done_transition: 'Done',
    ...configOverrides,
  };
  return new JiraAdapter('jira-test', config, { fetchJson: fetchJsonImpl });
}

function makeIssue(key = 'QUEST-1', fieldOverrides = {}) {
  return {
    key,
    fields: {
      summary: 'Test issue',
      description: 'A description',
      status: { name: 'Open' },
      priority: { name: 'Medium' },
      labels: ['backend'],
      issuetype: { name: 'Story' },
      assignee: null,
      ...fieldOverrides,
    },
  };
}

function makeSearchResponse(issues, total, startAt = 0) {
  return { issues, total, startAt, maxResults: 50 };
}

// --- Test suite ---

describe('JiraAdapter', () => {
  // T1: pull() maps a single Jira issue to correct QuestWorks task shape
  it('T1: pull() maps a single issue to correct shape', async () => {
    const issue = makeIssue('QUEST-1');
    const adapter = makeAdapter({}, async () => makeSearchResponse([issue], 1));

    const tasks = await adapter.pull();

    assert.equal(tasks.length, 1);
    const t = tasks[0];
    assert.equal(t.external_id, 'QUEST-1');
    assert.equal(t.external_url, 'https://test.atlassian.net/browse/QUEST-1');
    assert.equal(t.title, 'Test issue');
    assert.equal(t.description, 'A description');
    assert.deepEqual(t.labels, ['backend']);
    assert.equal(t.priority, 2); // Medium
    assert.equal(t.metadata.jira_status, 'Open');
    assert.equal(t.metadata.issue_type, 'Story');
    assert.equal(t.status, 'open');
    assert.equal(t.source, 'jira-test');
  });

  // T2: pull() handles empty results
  it('T2: pull() returns [] for zero issues', async () => {
    const adapter = makeAdapter({}, async () => makeSearchResponse([], 0));
    const tasks = await adapter.pull();
    assert.deepEqual(tasks, []);
  });

  // T3: pull() paginates when total > maxResults
  it('T3: pull() paginates when total > maxResults', async () => {
    const page1Issues = Array.from({ length: 50 }, (_, i) => makeIssue(`QUEST-${i + 1}`));
    const page2Issues = [makeIssue('QUEST-51')];
    let callCount = 0;

    const adapter = makeAdapter({}, async (_url, opts) => {
      const body = JSON.parse(opts.body);
      callCount++;
      if (body.startAt === 0) return makeSearchResponse(page1Issues, 51);
      return makeSearchResponse(page2Issues, 51, 50);
    });

    const tasks = await adapter.pull();
    assert.equal(tasks.length, 51);
    assert.equal(callCount, 2);
  });

  // T4: pull() catches HTTP errors and returns []
  it('T4: pull() catches errors and returns []', async () => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    const adapter = makeAdapter({}, async () => {
      throw new AdapterError('Network error', 0);
    });
    const tasks = await adapter.pull();

    console.error = origError;

    assert.deepEqual(tasks, []);
    assert.ok(errors.length > 0, 'should have logged an error');
  });

  // T5: claim() calls assignee and transition APIs; returns true
  it('T5: claim() assigns and transitions; returns true', async () => {
    const calls = [];
    const adapter = makeAdapter({}, async (url, opts) => {
      calls.push({ url, method: opts?.method });
      if (url.includes('/transitions') && (!opts?.method || opts.method === 'GET' || opts.method === undefined)) {
        return { transitions: [{ id: '21', name: 'In Progress' }, { id: '31', name: 'Done' }] };
      }
      return {};
    });

    const result = await adapter.claim({ external_id: 'QUEST-5' });

    assert.equal(result, true);
    const urls = calls.map(c => c.url);
    assert.ok(urls.some(u => u.includes('/assignee')), 'should call assignee API');
    assert.ok(urls.some(u => u.includes('/transitions')), 'should call transitions API');
  });

  // T6: claim() returns false when transition API returns 4xx
  it('T6: claim() returns false on transition 4xx', async () => {
    const adapter = makeAdapter({}, async (url, opts) => {
      if (url.includes('/transitions') && opts?.method === 'POST') {
        throw new AdapterError('Forbidden', 403);
      }
      if (url.includes('/transitions')) {
        return { transitions: [{ id: '21', name: 'In Progress' }] };
      }
      return {};
    });

    const result = await adapter.claim({ external_id: 'QUEST-5' });
    assert.equal(result, false);
  });

  // T7: update() with comment calls the issue comment API
  it('T7: update() with comment calls comment API', async () => {
    const calls = [];
    const adapter = makeAdapter({}, async (url, opts) => {
      calls.push({ url, method: opts?.method });
      return {};
    });

    await adapter.update({ external_id: 'QUEST-7' }, { comment: 'Working on it' });

    assert.ok(
      calls.some(c => c.url.includes('/comment') && c.method === 'POST'),
      'should POST to /comment',
    );
  });

  // T8: update() with no comment makes no API calls
  it('T8: update() with no comment makes no API calls', async () => {
    let called = false;
    const adapter = makeAdapter({}, async () => { called = true; return {}; });

    await adapter.update({ external_id: 'QUEST-8' }, { status: 'in_progress' });
    assert.equal(called, false, 'should make no API calls');
  });

  // T9: close() calls transition API with done transition ID
  it('T9: close() transitions issue to Done', async () => {
    const calls = [];
    const adapter = makeAdapter({}, async (url, opts) => {
      calls.push({ url, method: opts?.method, body: opts?.body });
      if (url.includes('/transitions') && (!opts?.method || opts.method === 'GET' || opts.method === undefined)) {
        return { transitions: [{ id: '31', name: 'Done' }, { id: '21', name: 'In Progress' }] };
      }
      return {};
    });

    await adapter.close({ external_id: 'QUEST-9' });

    const transitionPost = calls.find(c => c.url.includes('/transitions') && c.method === 'POST');
    assert.ok(transitionPost, 'should POST to transitions');
    const body = JSON.parse(transitionPost.body);
    assert.equal(body.transition.id, '31');
  });

  // T10: health() returns ok on 200
  it('T10: health() returns ok on 200', async () => {
    const adapter = makeAdapter({}, async () => ({ displayName: 'QuestBot' }));
    const result = await adapter.health();

    assert.equal(result.ok, true);
    assert.ok(result.message.includes('QuestBot'));
  });

  // T11: health() returns not-ok on 401
  it('T11: health() returns not-ok on 401', async () => {
    const adapter = makeAdapter({}, async () => {
      throw new AdapterError('Unauthorized', 401);
    });
    const result = await adapter.health();

    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0);
  });

  // T12: No credential values appear in logged output
  it('T12: no credential values appear in logged output', async () => {
    const loggedLines = [];
    const origError = console.error;
    console.error = (...args) => loggedLines.push(args.join(' '));

    const adapter = makeAdapter({}, async () => {
      throw new AdapterError('Bad request', 400);
    });

    await adapter.pull();
    await adapter.claim({ external_id: 'QUEST-12' });
    await adapter.update({ external_id: 'QUEST-12' }, { comment: 'test' });
    await adapter.close({ external_id: 'QUEST-12' });

    console.error = origError;

    const allLogs = loggedLines.join('\n');
    assert.ok(!allLogs.includes('secret-token'), 'token must not appear in logs');
    assert.ok(!allLogs.includes('bot@example.com'), 'email must not appear in logs');
  });
});
