/**
 * Slash command router and conversation engine for /qw commands.
 *
 * Exports:
 *   createSlashRouter(db)              — Express router for POST /slash
 *   handleConversationReply(db, post)  — called by websocket for continuation messages
 *
 * Flow lifecycle:
 *  1. POST /slash → parse command → call flow.start() → post to channel → 200 OK
 *  2. Conversation state stored in `conversations` table (TTL: 5 min).
 *  3. Subsequent user messages via WebSocket → handleConversationReply().
 */
import { Router } from 'express';
import express from 'express';
import { randomUUID } from 'crypto';
import { flows } from './flows/index.mjs';

const TTL_MS = 5 * 60 * 1000;

// ── MM API helper ─────────────────────────────────────────────────────────────

async function mmCreds(db) {
  const row = await db.queryOne("SELECT value FROM config WHERE key='mm_bot_token'", []);
  return {
    url: process.env.MM_URL,
    token: row?.value || process.env.MM_BOT_TOKEN,
  };
}

async function postToMm(db, channelId, message) {
  const { url, token } = await mmCreds(db);
  if (!url || !token) return;
  try {
    await fetch(`${url}/api/v4/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, message }),
    });
  } catch (err) {
    console.error('[slash] postToMm error:', err.message);
  }
}

// ── Command parser ────────────────────────────────────────────────────────────

const COMMAND_MAP = [
  ['adapter add github',     'adapter_add_github'],
  ['adapter add beads',      'adapter_add_beads'],
  ['adapter add jira',       'adapter_add_jira'],
  ['adapter list',           'adapter_list'],
  ['adapter remove',         'adapter_remove'],
  ['adapter sync',           'adapter_sync'],
  ['task list',              'task_list'],
  ['task claim',             'task_claim'],
  ['task done',              'task_done'],
  ['task block',             'task_block'],
  ['task add',               'task_add'],
  ['config set channel',     'config_set_channel'],
  ['config set sync-interval', 'config_set_sync_interval'],
  ['config show',            'config_show'],
  ['help',                   'help'],
];

function parseCommand(text) {
  const lower = (text || '').trim().toLowerCase();
  // Longest match first (array is already ordered by length descending where needed)
  for (const [cmd, flowName] of COMMAND_MAP) {
    if (lower === cmd || lower.startsWith(cmd + ' ')) {
      return { flowName, args: lower.slice(cmd.length).trim() };
    }
  }
  return null;
}

// ── Slash router ──────────────────────────────────────────────────────────────

export function createSlashRouter(db) {
  const router = Router();
  // Mattermost sends slash command payloads as application/x-www-form-urlencoded
  router.use(express.urlencoded({ extended: false }));

  router.post('/', async (req, res) => {
    const { user_id, channel_id, text } = req.body || {};
    if (!user_id || !channel_id) {
      return res.status(400).send('');
    }

    // Respond immediately so Mattermost doesn't time out
    res.status(200).send('');

    const parsed = parseCommand(text || '');
    if (!parsed) {
      await postToMm(db, channel_id, `Unknown command. Try \`/qw help\`.`);
      return;
    }

    const { flowName, args } = parsed;
    const flow = flows[flowName];
    if (!flow) {
      await postToMm(db, channel_id, `Unknown flow: \`${flowName}\`.`);
      return;
    }

    // Cancel any existing conversation for this user+channel (fresh start)
    await db.run('DELETE FROM conversations WHERE user_id=? AND channel_id=?', [user_id, channel_id]);

    let result;
    try {
      result = await flow.start(db, user_id, channel_id, args);
    } catch (err) {
      console.error(`[slash] flow.start(${flowName}) error:`, err);
      await postToMm(db, channel_id, `Error starting \`${flowName}\`: ${err.message}`);
      return;
    }

    await postToMm(db, channel_id, result.message);

    if (!result.done) {
      const now = new Date().toISOString();
      await db.run(
        'INSERT INTO conversations (id, user_id, channel_id, flow, step, data, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
        [randomUUID(), user_id, channel_id, flowName, '{}', now, now]
      );
    }
  });

  return router;
}

// ── Conversation reply handler ────────────────────────────────────────────────

export async function handleConversationReply(db, post) {
  const { user_id, channel_id, message } = post;

  const conv = await db.queryOne(
    'SELECT * FROM conversations WHERE user_id=? AND channel_id=?',
    [user_id, channel_id]
  );
  if (!conv) return;

  // TTL check — handle both ISO strings and legacy Unix timestamps (seconds)
  const updatedAtMs = /^\d+(\.\d+)?$/.test(String(conv.updated_at))
    ? Number(conv.updated_at) * 1000
    : new Date(conv.updated_at).getTime();
  const age = Date.now() - updatedAtMs;
  if (age > TTL_MS) {
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  const flow = flows[conv.flow];
  if (!flow) {
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  // Deserialize data for flow
  const convWithData = {
    ...conv,
    data: typeof conv.data === 'string' ? JSON.parse(conv.data || '{}') : (conv.data ?? {}),
  };

  let result;
  try {
    result = await flow.step(db, convWithData, message || '');
  } catch (err) {
    console.error(`[slash] flow.step(${conv.flow}) error:`, err);
    await postToMm(db, channel_id, `Error: ${err.message}`);
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  await postToMm(db, channel_id, result.message);

  if (result.done) {
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
  } else {
    const newStep = result.step !== undefined ? result.step : conv.step + 1;
    const newData = result.data !== undefined ? JSON.stringify(result.data) : conv.data;
    await db.run(
      'UPDATE conversations SET step=?, data=?, updated_at=? WHERE id=?',
      [newStep, newData, new Date().toISOString(), conv.id]
    );
  }
}
