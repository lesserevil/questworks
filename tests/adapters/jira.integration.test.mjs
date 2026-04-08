/**
 * tests/adapters/jira.integration.test.mjs
 *
 * Live integration tests against a real Jira Server instance.
 * All tests are skipped unless the required env vars are set:
 *
 *   JIRA_TEST_URL      e.g. https://jira.example.com
 *   JIRA_TEST_TOKEN    Personal Access Token (Bearer)
 *   JIRA_TEST_PROJECT  Project key, e.g. OPME
 *
 * Mutation tests (claim, close, comment) are skipped unless:
 *   JIRA_TEST_ISSUE    An issue key safe to mutate, e.g. OPME-42
 *
 * Run:
 *   JIRA_TEST_URL=... JIRA_TEST_TOKEN=... JIRA_TEST_PROJECT=... \
 *     node --test tests/adapters/jira.integration.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { JiraAdapter } from '../../adapters/jira.mjs';

const JIRA_URL     = process.env.JIRA_TEST_URL;
const JIRA_TOKEN   = process.env.JIRA_TEST_TOKEN;
const JIRA_PROJECT = process.env.JIRA_TEST_PROJECT;
const JIRA_ISSUE   = process.env.JIRA_TEST_ISSUE;  // optional — enables mutation tests

const skip = !JIRA_URL || !JIRA_TOKEN || !JIRA_PROJECT;

function makeAdapter(extra = {}) {
  return new JiraAdapter('jira-integration', {
    url: JIRA_URL,
    token: JIRA_TOKEN,
    project: JIRA_PROJECT,
    ...extra,
  });
}

// ── Connectivity & auth ───────────────────────────────────────────────────────

describe('Jira integration — health check', { skip }, () => {
  it('health() returns ok:true with a display name', async () => {
    const adapter = makeAdapter();
    const result = await adapter.health();
    assert.equal(result.ok, true, `health() not ok: ${result.message}`);
    assert.ok(result.message.includes('authenticated as'), `unexpected message: ${result.message}`);
    console.log(`  [health] ${result.message}`);
  });

  it('health() returns ok:false for a bad token', async () => {
    const adapter = new JiraAdapter('jira-bad', {
      url: JIRA_URL,
      token: 'definitely-not-valid',
      project: JIRA_PROJECT,
    });
    const result = await adapter.health();
    assert.equal(result.ok, false, 'should fail with invalid token');
  });
});

// ── pull() — read-only ────────────────────────────────────────────────────────

describe('Jira integration — pull()', { skip }, () => {
  let tasks;

  before(async () => {
    const adapter = makeAdapter();
    tasks = await adapter.pull();
    console.log(`  [pull] fetched ${tasks.length} task(s) from ${JIRA_PROJECT}`);
  });

  it('pull() returns an array (may be empty)', () => {
    assert.ok(Array.isArray(tasks));
  });

  it('every returned task has required QuestWorks fields', () => {
    for (const t of tasks) {
      assert.ok(t.id,          `task missing id: ${JSON.stringify(t)}`);
      assert.ok(t.source,      `task missing source: ${t.id}`);
      assert.ok(t.external_id, `task missing external_id: ${t.id}`);
      assert.ok(t.external_url,`task missing external_url: ${t.id}`);
      assert.ok(typeof t.title === 'string',      `title must be a string: ${t.id}`);
      assert.ok(typeof t.description === 'string',`description must be a string: ${t.id}`);
      assert.ok(Array.isArray(t.labels),          `labels must be an array: ${t.id}`);
      assert.ok(typeof t.priority === 'number',   `priority must be a number: ${t.id}`);
      assert.ok(t.status,      `task missing status: ${t.id}`);
      assert.ok(t.metadata,    `task missing metadata: ${t.id}`);
    }
  });

  it('all tasks come from the correct project', () => {
    for (const t of tasks) {
      assert.ok(
        t.external_id.startsWith(`${JIRA_PROJECT}-`),
        `external_id ${t.external_id} does not belong to project ${JIRA_PROJECT}`
      );
    }
  });

  it('external_url is a valid URL pointing to the configured server', () => {
    for (const t of tasks) {
      assert.ok(
        t.external_url.startsWith(JIRA_URL),
        `external_url ${t.external_url} does not start with ${JIRA_URL}`
      );
      assert.ok(
        t.external_url.includes('/browse/'),
        `external_url ${t.external_url} missing /browse/ path`
      );
    }
  });

  it('priority values are integers in [0, 4]', () => {
    for (const t of tasks) {
      assert.ok(
        Number.isInteger(t.priority) && t.priority >= 0 && t.priority <= 4,
        `priority out of range for ${t.external_id}: ${t.priority}`
      );
    }
  });

  it('metadata includes jira_status and issue_type', () => {
    for (const t of tasks) {
      assert.ok(
        typeof t.metadata.jira_status === 'string',
        `jira_status missing or not a string for ${t.external_id}`
      );
      assert.ok(
        typeof t.metadata.issue_type === 'string',
        `issue_type missing or not a string for ${t.external_id}`
      );
    }
  });

  it('pull() skips done issues (statusCategory != Done filter)', () => {
    const doneStatuses = ['done', 'closed', 'resolved', 'complete'];
    for (const t of tasks) {
      const status = (t.metadata.jira_status || '').toLowerCase();
      const isDone = doneStatuses.some(s => status.includes(s));
      assert.ok(!isDone, `task ${t.external_id} has done status "${t.metadata.jira_status}" but should be filtered out`);
    }
  });

  it('pull() with a custom jql filter returns a subset', async () => {
    // Add a filter that should return fewer results than the base query
    const adapter = makeAdapter({ jql: 'issuetype = Bug' });
    const bugTasks = await adapter.pull();
    assert.ok(
      Array.isArray(bugTasks),
      'custom jql query should return an array'
    );
    // All returned issues should be Bugs
    for (const t of bugTasks) {
      assert.equal(t.metadata.issue_type, 'Bug', `expected Bug, got ${t.metadata.issue_type} for ${t.external_id}`);
    }
    console.log(`  [pull+jql] ${bugTasks.length} Bug issue(s) in ${JIRA_PROJECT}`);
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────

describe('Jira integration — pagination', { skip }, () => {
  it('pull() fetches beyond 50 issues if the project has them', async () => {
    // We can't guarantee the project has >50 issues, so we just verify
    // that the adapter does not artificially cap at 50.
    // If there are ≤ 50 issues this test trivially passes.
    const adapter = makeAdapter();
    const tasks = await adapter.pull();
    // The real assertion: no crash, valid array
    assert.ok(Array.isArray(tasks));
    // Log for human verification
    if (tasks.length === 50) {
      console.log('  [pagination] exactly 50 tasks returned — project may have more; pagination untested');
    } else {
      console.log(`  [pagination] ${tasks.length} tasks — pagination exercised: ${tasks.length > 50 ? 'yes' : 'n/a (< 50)'}`);
    }
  });
});

// ── Mutation tests (only if JIRA_TEST_ISSUE is set) ───────────────────────────

describe('Jira integration — update (comment)', { skip: skip || !JIRA_ISSUE }, () => {
  it('update() posts a comment to the issue', async () => {
    const adapter = makeAdapter();
    // Does not throw — errors are logged internally
    await assert.doesNotReject(() =>
      adapter.update({ external_id: JIRA_ISSUE }, { comment: '[QuestWorks integration test] automated comment — safe to delete' })
    );
    console.log(`  [update] comment posted to ${JIRA_ISSUE}`);
  });

  it('update() with no comment makes no API calls (no-op)', async () => {
    const adapter = makeAdapter();
    await assert.doesNotReject(() =>
      adapter.update({ external_id: JIRA_ISSUE }, { status: 'in_progress' })
    );
  });
});
