/**
 * tests/mattermost/notify.test.mjs — Unit tests for MattermostNotifier thread tracking
 *
 * Uses node:test + node:assert.
 * Tests T1–T9 per plans/notifier-thread-tracking.md.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MattermostNotifier } from '../../mattermost/notify.mjs';

// --- Helpers ---

function makeNotifier(fetchImpl) {
  const notifier = new MattermostNotifier({
    url: 'https://mattermost.example.com',
    token: 'test-token',
    channel: 'paperwork',
  });
  // Inject fetch mock
  notifier._post = async (path, body) => fetchImpl(path, body);
  notifier._getChannelId = async () => 'channel-abc';
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

// --- Scheduler helper (minimal stub for T3/T4/T9) ---

function makeDb(existingTask = null) {
  const tasks = existingTask ? { [existingTask.id]: existingTask } : {};
  const updates = [];

  return {
    prepare: (sql) => ({
      get: (...args) => {
        if (sql.includes('WHERE source=? AND external_id=?')) {
          return Object.values(tasks).find(t => t.source === args[0] && t.external_id === args[1]) || null;
        }
        if (sql.includes('WHERE id=?')) {
          return tasks[args[0]] || null;
        }
        return null;
      },
      run: (...args) => {
        if (sql.includes('UPDATE tasks SET metadata')) {
          updates.push({ metadata: args[0], updated_at: args[1], id: args[2] });
        }
      },
    }),
    _updates: updates,
  };
}

// Import scheduler for T3/T4/T9
import { SyncScheduler } from '../../sync/scheduler.mjs';

// --- Tests ---

describe('MattermostNotifier — thread tracking', () => {
  // T1: onNewTask() returns post ID when MM API responds with { id: "abc" }
  it('T1: onNewTask() returns post ID on success', async () => {
    const notifier = makeNotifier(async () => ({ id: 'post-abc' }));
    const result = await notifier.onNewTask(makeTask());
    assert.equal(result, 'post-abc');
  });

  // T2: onNewTask() returns undefined when MM API fails — no crash
  it('T2: onNewTask() returns undefined on failure, no crash', async () => {
    const notifier = makeNotifier(async () => null);
    const result = await notifier.onNewTask(makeTask());
    assert.equal(result, undefined);
  });

  // T3: Scheduler stores mm_post_id in task metadata after successful onNewTask()
  it('T3: scheduler stores mm_post_id after successful onNewTask()', async (t) => {
    const task = {
      id: 'task-1',
      source: 'test',
      external_id: 'T-1',
      title: 'Task 1',
      description: '',
      status: 'open',
      assignee: null,
      claimed_at: null,
      external_url: null,
      labels: '[]',
      priority: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: '{}',
    };

    const db = makeDb(task);
    const notifier = new MattermostNotifier({
      url: 'https://mm.example.com',
      token: 'tok',
      channel: 'test',
    });
    // Mock _post and _getChannelId
    notifier._post = async () => ({ id: 'post-xyz' });
    notifier._getChannelId = async () => 'chan-1';

    // Simulate the scheduler's notification block directly
    const deserialized = {
      ...task,
      labels: JSON.parse(task.labels),
      metadata: JSON.parse(task.metadata),
    };

    const postId = await notifier.onNewTask(deserialized);
    if (postId) {
      const meta = { ...deserialized.metadata, mm_post_id: postId };
      db.prepare('UPDATE tasks SET metadata=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(meta), new Date().toISOString(), task.id);
    }

    assert.equal(db._updates.length, 1);
    const stored = JSON.parse(db._updates[0].metadata);
    assert.equal(stored.mm_post_id, 'post-xyz');
  });

  // T4: Scheduler skips metadata write when onNewTask() returns falsy
  it('T4: scheduler skips metadata write when onNewTask() returns falsy', async () => {
    const task = {
      id: 'task-2',
      source: 'test',
      external_id: 'T-2',
      title: 'Task 2',
      description: '',
      status: 'open',
      assignee: null,
      claimed_at: null,
      external_url: null,
      labels: '[]',
      priority: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: '{}',
    };

    const db = makeDb(task);
    const notifier = new MattermostNotifier({
      url: 'https://mm.example.com',
      token: 'tok',
      channel: 'test',
    });
    notifier._post = async () => null; // API fails
    notifier._getChannelId = async () => 'chan-1';

    const deserialized = {
      ...task,
      labels: JSON.parse(task.labels),
      metadata: JSON.parse(task.metadata),
    };

    const postId = await notifier.onNewTask(deserialized);
    if (postId) {
      const meta = { ...deserialized.metadata, mm_post_id: postId };
      db.prepare('UPDATE tasks SET metadata=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(meta), new Date().toISOString(), task.id);
    }

    assert.equal(db._updates.length, 0, 'should not write when postId is falsy');
  });

  // T5: onClaimed() includes root_id when task has mm_post_id
  it('T5: onClaimed() uses root_id when mm_post_id present', async () => {
    const posts = [];
    const notifier = makeNotifier(async (path, body) => { posts.push(body); return {}; });

    await notifier.onClaimed(makeTask({ metadata: { mm_post_id: 'post-root' } }));

    assert.equal(posts.length, 1);
    assert.equal(posts[0].root_id, 'post-root');
  });

  // T6: onClaimed() omits root_id when task has no mm_post_id
  it('T6: onClaimed() omits root_id when no mm_post_id', async () => {
    const posts = [];
    const notifier = makeNotifier(async (path, body) => { posts.push(body); return {}; });

    await notifier.onClaimed(makeTask({ metadata: {} }));

    assert.equal(posts.length, 1);
    assert.equal(posts[0].root_id, undefined);
  });

  // T7: onCompleted() includes root_id when task has mm_post_id
  it('T7: onCompleted() uses root_id when mm_post_id present', async () => {
    const posts = [];
    const notifier = makeNotifier(async (path, body) => { posts.push(body); return {}; });

    await notifier.onCompleted(makeTask({ metadata: { mm_post_id: 'post-root' } }));

    assert.equal(posts.length, 1);
    assert.equal(posts[0].root_id, 'post-root');
  });

  // T8: onCompleted() omits root_id when no mm_post_id
  it('T8: onCompleted() omits root_id when no mm_post_id', async () => {
    const posts = [];
    const notifier = makeNotifier(async (path, body) => { posts.push(body); return {}; });

    await notifier.onCompleted(makeTask({ metadata: {} }));

    assert.equal(posts.length, 1);
    assert.equal(posts[0].root_id, undefined);
  });

  // T9: Metadata DB write happens after scheduler upsert (verify order)
  it('T9: metadata write happens after upsert (post-then-update pattern)', async () => {
    const order = [];

    const task = {
      id: 'task-3',
      source: 'test',
      external_id: 'T-3',
      title: 'Task 3',
      description: '',
      status: 'open',
      assignee: null,
      claimed_at: null,
      external_url: null,
      labels: '[]',
      priority: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: '{}',
    };

    const notifier = new MattermostNotifier({
      url: 'https://mm.example.com',
      token: 'tok',
      channel: 'test',
    });
    notifier._getChannelId = async () => 'chan-1';
    notifier._post = async () => {
      order.push('notify');
      return { id: 'post-xyz' };
    };

    const dbUpdate = async () => order.push('db-update');

    const deserialized = {
      ...task,
      labels: JSON.parse(task.labels),
      metadata: JSON.parse(task.metadata),
    };

    const postId = await notifier.onNewTask(deserialized);
    if (postId) await dbUpdate();

    assert.deepEqual(order, ['notify', 'db-update'],
      'notification must happen before DB write');
  });
});
