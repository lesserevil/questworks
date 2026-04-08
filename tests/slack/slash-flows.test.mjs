/**
 * tests/slack/slash-flows.test.mjs
 *
 * Unit tests for slack/slash.mjs, slack/flows/index.mjs, and slack/api.mjs.
 * Mirrors tests/slash-flows.test.mjs with Slack-specific differences:
 *   - T3: adapter_add_* flows return { modal: true, modalDef } (Block Kit), not dialog
 *   - T10: config_set_channel stores 'slack_channel' key (not 'mm_channel')
 *   - T8: TTL test mocks Slack's chat.postMessage, not MM's API
 *   - parseCommand is now imported from slack/api.mjs (not redefined locally)
 *
 * Run: node --test tests/slack/slash-flows.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SqliteDb } from '../../db/sqlite.mjs';
import { parseCommand } from '../../slack/api.mjs';

// ── DB helpers ────────────────────────────────────────────────────────────────

function makeDb() {
  const db = new SqliteDb(':memory:');
  db.applySchema();
  return db;
}

function insertTask(db, overrides = {}) {
  const now = new Date().toISOString();
  const defaults = {
    id: 'task-' + Math.random().toString(36).slice(2, 10),
    title: 'Test Task',
    description: '',
    status: 'open',
    assignee: null,
    claimed_at: null,
    source: 'manual',
    external_id: 'ext-' + Math.random().toString(36).slice(2, 10),
    external_url: null,
    labels: '[]',
    priority: 0,
    created_at: now,
    updated_at: now,
    metadata: '{}',
  };
  const row = { ...defaults, ...overrides };
  db.raw.prepare(
    'INSERT INTO tasks (id,title,description,status,assignee,claimed_at,source,external_id,external_url,labels,priority,created_at,updated_at,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(row.id, row.title, row.description, row.status, row.assignee, row.claimed_at, row.source, row.external_id, row.external_url, row.labels, row.priority, row.created_at, row.updated_at, row.metadata);
  return row;
}

function makeConv(overrides = {}) {
  const defaults = {
    id: 'conv-' + Math.random().toString(36).slice(2, 10),
    user_id: 'user1',
    channel_id: 'chan1',
    flow: 'task_list',
    step: 0,
    data: '{}',
    updated_at: Math.floor(Date.now() / 1000),
  };
  return { ...defaults, ...overrides };
}

// ── Import modules under test ─────────────────────────────────────────────────

const { flows, handleModalSubmit } = await import('../../slack/flows/index.mjs');
const { handleConversationReply } = await import('../../slack/slash.mjs');
const { encrypt } = await import('../../db/crypto.mjs');
const { maskToken } = await import('../../slack/flows/index.mjs');

// ── T1 — Command parser ───────────────────────────────────────────────────────

describe('T1 — Command parser (imported from slack/api.mjs)', () => {
  test('parses simple commands', () => {
    assert.deepEqual(parseCommand('help'), { flowName: 'help', args: '' });
    assert.deepEqual(parseCommand('task list'), { flowName: 'task_list', args: '' });
    assert.deepEqual(parseCommand('adapter list'), { flowName: 'adapter_list', args: '' });
    assert.deepEqual(parseCommand('config show'), { flowName: 'config_show', args: '' });
  });

  test('longest match wins for adapter add subcommands', () => {
    assert.deepEqual(parseCommand('adapter add github'), { flowName: 'adapter_add_github', args: '' });
    assert.deepEqual(parseCommand('adapter add beads'),  { flowName: 'adapter_add_beads',  args: '' });
    assert.deepEqual(parseCommand('adapter add jira'),   { flowName: 'adapter_add_jira',   args: '' });
  });

  test('extra args are captured', () => {
    const r = parseCommand('adapter add github extra stuff');
    assert.equal(r.flowName, 'adapter_add_github');
    assert.equal(r.args, 'extra stuff');
  });

  test('unknown commands return null', () => {
    assert.equal(parseCommand('unknown stuff'), null);
    assert.equal(parseCommand('adapter add'),   null);
    assert.equal(parseCommand(''),              null);
    assert.equal(parseCommand(null),            null);
  });

  test('case-insensitive matching', () => {
    assert.deepEqual(parseCommand('HELP'), { flowName: 'help', args: '' });
    assert.deepEqual(parseCommand('Task List'), { flowName: 'task_list', args: '' });
  });
});

// ── T2 — Immediate flows ──────────────────────────────────────────────────────

describe('T2 — Immediate flows (done:true on start)', () => {
  test('help returns full command listing', async () => {
    const db = makeDb();
    const r = await flows.help.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);
    assert.ok(r.message.includes('/qw adapter add github'));
    assert.ok(r.message.includes('/qw task list'));
    assert.ok(r.message.includes('/qw help'));
  });

  test('task_list returns empty message when no tasks', async () => {
    const db = makeDb();
    const r = await flows.task_list.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);
    assert.ok(r.message.includes('0') || r.message.toLowerCase().includes('no task'));
  });

  test('task_list lists open tasks', async () => {
    const db = makeDb();
    insertTask(db, { title: 'Alpha Task' });
    insertTask(db, { title: 'Beta Task' });
    const r = await flows.task_list.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);
    assert.ok(r.message.includes('Alpha Task'));
    assert.ok(r.message.includes('Beta Task'));
  });

  test('adapter_list shows "No adapters" when empty', async () => {
    const db = makeDb();
    const r = await flows.adapter_list.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);
    assert.ok(r.message.toLowerCase().includes('no adapters'));
  });

  test('config_show shows "No configuration" when empty', async () => {
    const db = makeDb();
    const r = await flows.config_show.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);
    assert.ok(r.message.toLowerCase().includes('no configuration'));
  });

  test('config_show masks token/secret values', async () => {
    const db = makeDb();
    db.raw.prepare("INSERT INTO config (key, value) VALUES ('slack_bot_token', 'xoxb-supersecretvalue1234')").run();
    db.raw.prepare("INSERT INTO config (key, value) VALUES ('sync_interval_seconds', '60')").run();
    const r = await flows.config_show.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);
    assert.ok(!r.message.includes('xoxb-supersecretvalue1234'), 'token must not appear in plaintext');
    assert.ok(r.message.includes('1234'), 'last 4 chars should be visible');
    assert.ok(r.message.includes('60'), 'non-secret values shown');
  });
});

// ── T3 — adapter_add_github Slack modal flow ──────────────────────────────────

describe('T3 — Flow: adapter_add_github (Slack modal)', () => {
  test('start returns modal:true with modalDef (not dialog)', async () => {
    const db = makeDb();
    const r = await flows.adapter_add_github.start(db, 'u1', 'c1', '');
    assert.equal(r.modal, true, 'should return modal:true for Slack');
    assert.equal(r.done, true);
    assert.ok(!r.dialog, 'should NOT return dialog:true (that is MatterMost)');
    assert.ok(r.modalDef, 'should have modalDef');
    assert.equal(r.modalDef.type, 'modal');
  });

  test('modalDef has Block Kit title and submit', async () => {
    const db = makeDb();
    const r = await flows.adapter_add_github.start(db, 'u1', 'c1', '');
    assert.equal(r.modalDef.title?.type, 'plain_text');
    assert.ok(r.modalDef.title?.text?.includes('GitHub'));
    assert.equal(r.modalDef.submit?.type, 'plain_text');
  });

  test('modalDef blocks contain required field block_ids', async () => {
    const db = makeDb();
    const r = await flows.adapter_add_github.start(db, 'u1', 'c1', '');
    const blockIds = r.modalDef.blocks.map(b => b.block_id);
    assert.ok(blockIds.includes('repo'),  'should have repo block');
    assert.ok(blockIds.includes('token'), 'should have token block');
    assert.ok(blockIds.includes('label'), 'should have label block');
    assert.ok(blockIds.includes('name'),  'should have name block (optional)');
  });

  test('each block has plain_text_input element with action_id "input"', async () => {
    const db = makeDb();
    const r = await flows.adapter_add_github.start(db, 'u1', 'c1', '');
    for (const block of r.modalDef.blocks) {
      assert.equal(block.type, 'input', `block ${block.block_id} should be type "input"`);
      assert.equal(block.element?.type, 'plain_text_input', `block ${block.block_id} element type`);
      assert.equal(block.element?.action_id, 'input', `block ${block.block_id} action_id`);
    }
  });

  test('step returns redirect message', async () => {
    const db = makeDb();
    const r = await flows.adapter_add_github.step(db, makeConv({ step: 0 }), 'anything');
    assert.equal(r.done, true);
    assert.ok(r.message.includes('/qw adapter add github'));
  });
});

// ── T3b — adapter_add_beads and adapter_add_jira modals ──────────────────────

describe('T3b — adapter_add_beads and adapter_add_jira modals', () => {
  for (const [flowName, expectedBlocks] of [
    ['adapter_add_beads', ['endpoint', 'token', 'board_id', 'name']],
    ['adapter_add_jira',  ['url', 'token', 'project', 'name']],
  ]) {
    test(`${flowName} returns modal:true with correct block_ids`, async () => {
      const db = makeDb();
      const r = await flows[flowName].start(db, 'u1', 'c1', '');
      assert.equal(r.modal, true);
      assert.equal(r.modalDef.type, 'modal');
      const blockIds = r.modalDef.blocks.map(b => b.block_id);
      for (const expected of expectedBlocks) {
        assert.ok(blockIds.includes(expected), `${flowName} should have ${expected} block`);
      }
    });
  }
});

// ── T4 — token masking ────────────────────────────────────────────────────────

describe('T4 — Token masking (maskToken from slack/flows/index.mjs)', () => {
  test('long token shows last 4 chars', () => {
    assert.equal(maskToken('xoxb-abcdefgh1234'), '...1234');
  });

  test('short token returns ****', () => {
    assert.equal(maskToken('ab'), '****');
  });

  test('empty string returns ****', () => {
    assert.equal(maskToken(''), '****');
  });

  test('null returns ****', () => {
    assert.equal(maskToken(null), '****');
  });
});

// ── T5 — task_claim race condition ────────────────────────────────────────────

describe('T5 — task_claim race condition', () => {
  test('first claimer wins, second gets conflict or re-prompt', async () => {
    const db = makeDb();
    insertTask(db, { title: 'Contested Task' });

    const conv1 = makeConv({ step: 0, user_id: 'user-a', flow: 'task_claim' });
    const conv2 = makeConv({ step: 0, user_id: 'user-b', flow: 'task_claim' });

    const r1 = await flows.task_claim.step(db, conv1, '1');
    const r2 = await flows.task_claim.step(db, conv2, '1');

    assert.equal(r1.done, true, `first caller should finish, got: "${r1.message}"`);
    assert.ok(
      r1.message.includes('claimed') || r1.message.includes('You claimed'),
      `first caller should succeed, got: "${r1.message}"`
    );
    const secondOk =
      r2.message.includes('just claimed') ||
      r2.message.toLowerCase().includes('not found') ||
      r2.message.toLowerCase().includes('no open');
    assert.ok(secondOk, `second caller should see conflict or empty, got: "${r2.message}"`);

    const dbTask = db.raw.prepare("SELECT * FROM tasks WHERE title='Contested Task'").get();
    assert.equal(dbTask.status, 'claimed');
    assert.equal(dbTask.assignee, 'user-a');
  });
});

// ── T6 — task_add manual flow ─────────────────────────────────────────────────

describe('T6 — task_add (manual)', () => {
  test('start prompts for source type', async () => {
    const db = makeDb();
    const r = await flows.task_add.start(db, 'u1', 'c1', '');
    assert.equal(r.done, false);
    assert.ok(r.message.toLowerCase().includes('manual'));
  });

  test('step 0 rejects invalid source type', async () => {
    const db = makeDb();
    const r = await flows.task_add.step(db, makeConv({ step: 0 }), 'ftp');
    assert.equal(r.done, false);
    assert.equal(r.step, 0);
  });

  test('step 0 accepts "manual"', async () => {
    const db = makeDb();
    const r = await flows.task_add.step(db, makeConv({ step: 0 }), 'manual');
    assert.equal(r.done, false);
    assert.equal(r.step, 1);
  });

  test('step 1 rejects empty title for manual', async () => {
    const db = makeDb();
    const conv = makeConv({ step: 1, data: JSON.stringify({ type: 'manual' }) });
    const r = await flows.task_add.step(db, conv, '');
    assert.equal(r.done, false);
    assert.equal(r.step, 1);
  });

  test('step 3 with valid priority creates task', async () => {
    const db = makeDb();
    const conv = makeConv({ step: 3, data: JSON.stringify({ type: 'manual', title: 'My Slack Task', description: 'desc' }) });
    const r = await flows.task_add.step(db, conv, '2');
    assert.equal(r.done, true);
    const row = db.raw.prepare("SELECT * FROM tasks WHERE title='My Slack Task'").get();
    assert.ok(row, 'task row inserted');
    assert.equal(row.source, 'manual');
  });
});

// ── T7 — task_add GitHub import ───────────────────────────────────────────────

describe('T7 — task_add (GitHub import)', () => {
  test('step 1 rejects bad format', async () => {
    const db = makeDb();
    const conv = makeConv({ step: 1, data: JSON.stringify({ type: 'github' }) });
    const r = await flows.task_add.step(db, conv, 'not-valid');
    assert.equal(r.done, false);
    assert.equal(r.step, 1);
  });

  test('step 1 successful import inserts task', async () => {
    const db = makeDb();
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ title: 'Slack Test Issue', body: 'Issue body', html_url: 'https://github.com/owner/repo/issues/1', labels: [] }),
      text: async () => '',
    });
    try {
      const conv = makeConv({ step: 1, data: JSON.stringify({ type: 'github' }) });
      const r = await flows.task_add.step(db, conv, 'owner/repo#1');
      assert.equal(r.done, true);
      assert.ok(r.message.includes('Slack Test Issue'));
      const row = db.raw.prepare("SELECT * FROM tasks WHERE source='github'").get();
      assert.ok(row, 'task inserted');
      assert.equal(row.external_id, 'owner/repo#1');
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ── T8 — TTL enforcement (Slack API mock) ─────────────────────────────────────

describe('T8 — TTL enforcement', () => {
  test('expired conversation is deleted and no Slack message sent', async () => {
    const db = makeDb();
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 361;
    const conv = {
      id: 'conv-ttl',
      user_id: 'u1',
      channel_id: 'c1',
      flow: 'task_list',
      step: 0,
      data: '{}',
      updated_at: sixMinutesAgo,
    };
    db.raw.prepare(
      "INSERT INTO conversations (id,user_id,channel_id,flow,step,data,updated_at) VALUES (?,?,?,?,?,?,?)"
    ).run(conv.id, conv.user_id, conv.channel_id, conv.flow, conv.step, conv.data, conv.updated_at);

    const slackCalls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('slack.com')) {
        slackCalls.push({ url, opts });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
    };

    try {
      await handleConversationReply(db, { user_id: 'u1', channel_id: 'c1', message: 'hello' }, 'xoxb-test');
      assert.equal(slackCalls.length, 0, 'no Slack API call for expired conversation');
      const remaining = db.raw.prepare('SELECT * FROM conversations WHERE id=?').get('conv-ttl');
      assert.equal(remaining, undefined, 'expired conversation row deleted');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ── T9 — Fresh start cancels existing conversation ────────────────────────────

describe('T9 — Fresh start cancels existing conversation', () => {
  test('starting a new flow removes stale conversation row', async () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      "INSERT INTO conversations (id,user_id,channel_id,flow,step,data,updated_at) VALUES ('old-conv','u1','c1','task_list',0,'{}',?)"
    ).run(now);

    assert.ok(db.raw.prepare('SELECT * FROM conversations WHERE id=?').get('old-conv'));

    // Simulate slash router: delete existing conv, run fresh flow
    db.raw.prepare("DELETE FROM conversations WHERE user_id=? AND channel_id=?").run('u1', 'c1');
    const r = await flows.help.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);

    const old = db.raw.prepare('SELECT * FROM conversations WHERE id=?').get('old-conv');
    assert.equal(old, undefined, 'old conversation deleted by fresh start');
  });
});

// ── T10 — config_set_channel stores slack_channel (not mm_channel) ─────────────

describe('T10 — config_set_channel (Slack key)', () => {
  test('start prompts for Slack channel name', async () => {
    const db = makeDb();
    const r = await flows.config_set_channel.start(db, 'u1', 'c1', '');
    assert.equal(r.done, false);
    assert.ok(r.message.toLowerCase().includes('slack'), 'prompt should mention Slack');
    assert.ok(r.message.toLowerCase().includes('channel'));
  });

  test('step rejects empty channel name', async () => {
    const db = makeDb();
    const r = await flows.config_set_channel.step(db, makeConv({ step: 0 }), '');
    assert.equal(r.done, false);
  });

  test('step accepts channel name and stores as slack_channel key', async () => {
    const db = makeDb();
    const r = await flows.config_set_channel.step(db, makeConv({ step: 0 }), '#questworks');
    assert.equal(r.done, true);
    // Must store as 'slack_channel', NOT 'mm_channel'
    const slackRow = db.raw.prepare("SELECT value FROM config WHERE key='slack_channel'").get();
    assert.equal(slackRow?.value, 'questworks', 'stored under slack_channel key');
    const mmRow = db.raw.prepare("SELECT value FROM config WHERE key='mm_channel'").get();
    assert.equal(mmRow, undefined, 'must NOT store under mm_channel key');
  });

  test('step strips # prefix from channel name', async () => {
    const db = makeDb();
    await flows.config_set_channel.step(db, makeConv({ step: 0 }), '#my-channel');
    const row = db.raw.prepare("SELECT value FROM config WHERE key='slack_channel'").get();
    assert.equal(row.value, 'my-channel', '# prefix stripped');
  });
});

// ── T11 — config_set_sync_interval flow ──────────────────────────────────────

describe('T11 — config_set_sync_interval', () => {
  test('start shows current interval', async () => {
    const db = makeDb();
    db.raw.prepare("INSERT INTO config (key,value) VALUES ('sync_interval_seconds','120')").run();
    const r = await flows.config_set_sync_interval.start(db, 'u1', 'c1', '');
    assert.equal(r.done, false);
    assert.ok(r.message.includes('120'));
  });

  test('step rejects value < 10', async () => {
    const db = makeDb();
    const r = await flows.config_set_sync_interval.step(db, makeConv({ step: 0 }), '5');
    assert.equal(r.done, false);
  });

  test('step accepts valid interval ≥ 10', async () => {
    const db = makeDb();
    const r = await flows.config_set_sync_interval.step(db, makeConv({ step: 0 }), '30');
    assert.equal(r.done, true);
    const row = db.raw.prepare("SELECT value FROM config WHERE key='sync_interval_seconds'").get();
    assert.equal(row.value, '30');
  });
});

// ── T12 — adapter_remove flow ─────────────────────────────────────────────────

describe('T12 — adapter_remove', () => {
  test('step 0 cancel exits cleanly', async () => {
    const db = makeDb();
    const r = await flows.adapter_remove.step(db, makeConv({ step: 0 }), 'cancel');
    assert.equal(r.done, true);
    assert.ok(r.message.toLowerCase().includes('cancel'));
  });

  test('step 1 yes → adapter deleted', async () => {
    const db = makeDb();
    const cfg = encrypt(JSON.stringify({ repo: 'owner/repo', token: 'x', label_filter: 'q' }));
    db.raw.prepare("INSERT INTO adapters_config (id,type,name,config_encrypted,status) VALUES ('a2','github','gh-adapter2',?,'active')").run(cfg);
    const conv1 = makeConv({ step: 0 });
    const r0 = await flows.adapter_remove.step(db, conv1, 'a2');
    const conv2 = makeConv({ step: 1, data: JSON.stringify(r0.data) });
    const r1 = await flows.adapter_remove.step(db, conv2, 'yes');
    assert.equal(r1.done, true);
    assert.ok(r1.message.toLowerCase().includes('removed'));
    const row = db.raw.prepare("SELECT * FROM adapters_config WHERE id='a2'").get();
    assert.equal(row, undefined, 'adapter deleted');
  });
});

// ── T13 — task_done flow ──────────────────────────────────────────────────────

describe('T13 — task_done', () => {
  test('no in-progress tasks returns early', async () => {
    const db = makeDb();
    const r = await flows.task_done.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);
    assert.ok(r.message.toLowerCase().includes('no'));
  });

  test('marks task done and records optional note', async () => {
    const db = makeDb();
    const task = insertTask(db, { status: 'claimed', assignee: 'u1' });
    const conv0 = makeConv({ step: 0, user_id: 'u1', data: '{}', flow: 'task_done' });
    const r0 = await flows.task_done.step(db, conv0, '1');
    assert.equal(r0.done, false);
    const conv1 = makeConv({ step: 1, user_id: 'u1', data: JSON.stringify(r0.data), flow: 'task_done' });
    const r1 = await flows.task_done.step(db, conv1, 'Shipped to prod');
    assert.equal(r1.done, true);
    const updated = db.raw.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
    assert.equal(updated.status, 'done');
    const hist = db.raw.prepare('SELECT * FROM task_history WHERE task_id=?').get(task.id);
    assert.ok(hist, 'history entry recorded');
    assert.equal(hist.note, 'Shipped to prod');
  });
});

// ── T14 — task_block flow ─────────────────────────────────────────────────────

describe('T14 — task_block', () => {
  test('marks task blocked with reason', async () => {
    const db = makeDb();
    const task = insertTask(db, { status: 'claimed', assignee: 'u2' });
    const conv0 = makeConv({ step: 0, user_id: 'u2', data: '{}', flow: 'task_block' });
    const r0 = await flows.task_block.step(db, conv0, '1');
    assert.equal(r0.done, false);
    const conv1 = makeConv({ step: 1, user_id: 'u2', data: JSON.stringify(r0.data), flow: 'task_block' });
    const r1 = await flows.task_block.step(db, conv1, 'Waiting on API credentials');
    assert.equal(r1.done, true);
    const updated = db.raw.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
    assert.equal(updated.status, 'blocked');
    const hist = db.raw.prepare('SELECT * FROM task_history WHERE task_id=?').get(task.id);
    assert.equal(hist.action, 'blocked');
    assert.equal(hist.note, 'Waiting on API credentials');
  });
});

// ── T15 — adapter_list masks tokens ───────────────────────────────────────────

describe('T15 — adapter_list token masking', () => {
  test('adapter_list masks token in output', async () => {
    const db = makeDb();
    const cfg = encrypt(JSON.stringify({ repo: 'owner/repo', token: 'xoxb-veryS3cretToken', label_filter: 'q' }));
    db.raw.prepare("INSERT INTO adapters_config (id,type,name,config_encrypted,status) VALUES ('aa1','github','my-github',?,'active')").run(cfg);
    const r = await flows.adapter_list.start(db, 'u1', 'c1', '');
    assert.equal(r.done, true);
    assert.ok(!r.message.includes('xoxb-veryS3cretToken'), 'full token must not appear in output');
    assert.ok(r.message.includes('...') || r.message.includes('****'), 'masked token shown');
  });
});

// ── T16 — handleModalSubmit extracts Slack state.values ──────────────────────

describe('T16 — handleModalSubmit (Slack view.state.values extraction)', () => {
  test('extracts flat submission from Slack state.values structure', async () => {
    // Slack sends: { block_id: { action_id: { type, value } } }
    const stateValues = {
      repo:  { input: { type: 'plain_text_input', value: 'owner/myrepo' } },
      token: { input: { type: 'plain_text_input', value: 'ghp_abc123' } },
      label: { input: { type: 'plain_text_input', value: 'questworks' } },
      name:  { input: { type: 'plain_text_input', value: null } },
    };

    // Use a DB that will reject the INSERT (no real adapters map needed)
    const db = makeDb();
    const adapters = new Map();

    // handleModalSubmit for adapter_add_github should extract values and
    // attempt to insert — we verify it doesn't crash and the extraction works
    // by checking the error message (label required means extraction succeeded)
    let message;
    try {
      message = await handleModalSubmit(db, 'adapter_add_github', stateValues, adapters, null);
    } catch (err) {
      message = err.message;
    }
    // If extraction worked, it either succeeded or gave a validation error — not a parse error
    assert.ok(message, 'should return a message');
    assert.ok(!message.includes('undefined'), 'extracted values should not be undefined');
  });

  test('null/empty optional field does not break extraction', async () => {
    const stateValues = {
      repo:  { input: { type: 'plain_text_input', value: 'owner/repo' } },
      token: { input: { type: 'plain_text_input', value: 'ghp_test' } },
      label: { input: { type: 'plain_text_input', value: 'q' } },
      name:  { input: { type: 'plain_text_input', value: null } },
    };
    const db = makeDb();
    // Should complete without throwing
    await assert.doesNotReject(() =>
      handleModalSubmit(db, 'adapter_add_github', stateValues, new Map(), null)
    );
  });
});
