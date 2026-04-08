/**
 * tests/slack/notify.test.mjs — Unit tests for SlackNotifier thread tracking
 *
 * Mirrors tests/mattermost/notify.test.mjs with Slack-specific differences:
 *   - onNewTask() returns ts (timestamp string) instead of post id
 *   - Threading uses thread_ts instead of root_id
 *   - Metadata key is slack_ts instead of mm_post_id
 *   - API response: { ok: true, ts: '...' }
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SlackNotifier } from '../../slack/notify.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNotifier(postImpl) {
  const notifier = new SlackNotifier({ token: 'xoxb-test', channel: 'questworks' });
  notifier._post = async (path, body) => postImpl(path, body);
  notifier._getChannelId = async () => 'C0123CHAN';
  return notifier;
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Do the thing',
    description: 'Some description',
    source: 'jira-test',
    external_id: 'QUEST-1',
    external_url: 'https://jira.example.com/browse/QUEST-1',
    assignee: 'hadji',
    status: 'open',
    labels: [],
    priority: 2,
    metadata: {},
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SlackNotifier — thread tracking', () => {

  // T1: onNewTask() returns ts when Slack API responds with { ok: true, ts: '...' }
  it('T1: onNewTask() returns ts on success', async () => {
    const notifier = makeNotifier(async () => ({ ok: true, ts: '1234567890.000100' }));
    const result = await notifier.onNewTask(makeTask());
    assert.equal(result, '1234567890.000100');
  });

  // T2: onNewTask() returns undefined when Slack API fails — no crash
  it('T2: onNewTask() returns undefined on failure, no crash', async () => {
    const notifier = makeNotifier(async () => null);
    const result = await notifier.onNewTask(makeTask());
    assert.equal(result, undefined);
  });

  // T3: onNewTask() returns undefined when API returns ok:false — no crash
  it('T3: onNewTask() returns undefined when ok:false', async () => {
    const notifier = makeNotifier(async () => ({ ok: false, error: 'channel_not_found' }));
    const result = await notifier.onNewTask(makeTask());
    assert.equal(result, undefined);
  });

  // T4: Stores slack_ts in task metadata after successful onNewTask()
  it('T4: slack_ts is stored in metadata after successful notify', async () => {
    const notifier = makeNotifier(async () => ({ ok: true, ts: '1234567890.000200' }));
    const task = makeTask({ metadata: {} });
    const ts = await notifier.onNewTask(task);
    assert.equal(ts, '1234567890.000200');
    // Simulate what the scheduler does: store ts in metadata
    if (ts) task.metadata.slack_ts = ts;
    assert.equal(task.metadata.slack_ts, '1234567890.000200');
  });

  // T5: Scheduler skips metadata write when onNewTask() returns falsy
  it('T5: no metadata write when onNewTask() returns falsy', async () => {
    const notifier = makeNotifier(async () => null);
    const task = makeTask({ metadata: {} });
    const ts = await notifier.onNewTask(task);
    assert.equal(ts, undefined);
    assert.equal(task.metadata.slack_ts, undefined, 'slack_ts should not be set');
  });

  // T6: onClaimed() includes thread_ts when task has slack_ts
  it('T6: onClaimed() uses thread_ts when slack_ts present', async () => {
    const posts = [];
    const notifier = makeNotifier(async (path, body) => { posts.push(body); return { ok: true }; });
    await notifier.onClaimed(makeTask({ metadata: { slack_ts: '1111.000001' } }));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].thread_ts, '1111.000001');
  });

  // T7: onClaimed() omits thread_ts when task has no slack_ts
  it('T7: onClaimed() omits thread_ts when no slack_ts', async () => {
    const posts = [];
    const notifier = makeNotifier(async (path, body) => { posts.push(body); return { ok: true }; });
    await notifier.onClaimed(makeTask({ metadata: {} }));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].thread_ts, undefined);
  });

  // T8: onCompleted() includes thread_ts when task has slack_ts
  it('T8: onCompleted() uses thread_ts when slack_ts present', async () => {
    const posts = [];
    const notifier = makeNotifier(async (path, body) => { posts.push(body); return { ok: true }; });
    await notifier.onCompleted(makeTask({ metadata: { slack_ts: '2222.000002' } }));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].thread_ts, '2222.000002');
  });

  // T9: onCompleted() omits thread_ts when no slack_ts
  it('T9: onCompleted() omits thread_ts when no slack_ts', async () => {
    const posts = [];
    const notifier = makeNotifier(async (path, body) => { posts.push(body); return { ok: true }; });
    await notifier.onCompleted(makeTask({ metadata: {} }));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].thread_ts, undefined);
  });

  // T10: SlackNotifier is disabled (no crash) when no token provided
  it('T10: disabled notifier does nothing, returns undefined', async () => {
    const notifier = new SlackNotifier({ token: '', channel: 'questworks' });
    const result = await notifier.onNewTask(makeTask());
    assert.equal(result, undefined);
    // No crash on claimed/completed either
    await assert.doesNotReject(() => notifier.onClaimed(makeTask()));
    await assert.doesNotReject(() => notifier.onCompleted(makeTask()));
  });

  // T11: Notify-then-DB-write ordering
  it('T11: notification happens before metadata DB write', async () => {
    const order = [];
    const notifier = makeNotifier(async () => { order.push('notify'); return { ok: true, ts: '9999.000001' }; });
    const dbWrite = async () => order.push('db-write');

    const ts = await notifier.onNewTask(makeTask());
    if (ts) await dbWrite();

    assert.deepEqual(order, ['notify', 'db-write'], 'notification must precede DB write');
  });

  // T12: onNewTask() posts to correct Slack endpoint with channel
  it('T12: onNewTask() posts to /chat.postMessage with channel', async () => {
    const calls = [];
    const notifier = makeNotifier(async (path, body) => { calls.push({ path, body }); return { ok: true, ts: '123.456' }; });
    await notifier.onNewTask(makeTask());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/chat.postMessage');
    assert.equal(calls[0].body.channel, 'C0123CHAN');
  });
});
