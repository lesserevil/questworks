/**
 * Slack slash command router and conversation engine for /qw commands.
 *
 * Exports:
 *   createSlashRouter(db, adapters, scheduler, slackOpts)
 *     — Express router mounted at /slash
 *     — POST /slash          → /qw command entry point
 *     — POST /slash/interactions → Slack modal submissions + block actions
 *
 * Flow lifecycle:
 *  1. POST /slash → parse command → call flow.start() → 200 OK
 *  2. If flow returns { modal: true, modalDef } → opens a Slack modal via views.open.
 *  3. Modal submission hits POST /slash/interactions (payload.type === 'view_submission').
 *  4. Non-modal flows store conversation state in `conversations` table (TTL 5 min).
 *  5. Subsequent user replies arrive via the Events API → handleConversationReply().
 */
import { Router } from 'express';
import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import { flows, handleModalSubmit } from './flows/index.mjs';
import { postToSlack, openSlackModal, parseCommand } from './api.mjs';

const TTL_MS = 5 * 60 * 1000;

// ── Signature verification ────────────────────────────────────────────────────

function verifySlackSignature(signingSecret, rawBody, headers) {
  const timestamp = headers['x-slack-request-timestamp'];
  const sig = headers['x-slack-signature'];
  if (!timestamp || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const hash = 'v0=' + createHmac('sha256', signingSecret).update(base).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(sig));
  } catch {
    return false;
  }
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createSlashRouter(db, adapters, scheduler, { token = '', signingSecret = '' } = {}) {
  const router = Router();

  // Capture raw body for signature verification before URL-encoded parsing
  router.use(express.urlencoded({
    extended: false,
    verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
  }));

  // ── POST /slash ─────────────────────────────────────────────────────────────

  router.post('/', async (req, res) => {
    if (signingSecret) {
      if (!verifySlackSignature(signingSecret, req.rawBody || '', req.headers)) {
        return res.status(401).send('');
      }
    }

    const { user_id, channel_id, text, trigger_id } = req.body || {};
    if (!user_id || !channel_id) return res.status(400).send('');

    // Acknowledge immediately — Slack requires < 3s response
    res.status(200).send('');

    const parsed = parseCommand(text || '');
    if (!parsed) {
      await postToSlack(token, channel_id, 'Unknown command. Try `/qw help`.');
      return;
    }

    const { flowName, args } = parsed;
    const flow = flows[flowName];
    if (!flow) {
      await postToSlack(token, channel_id, `Unknown flow: \`${flowName}\`.`);
      return;
    }

    // Cancel any stale conversation for this user+channel
    await db.run('DELETE FROM conversations WHERE user_id=? AND channel_id=?', [user_id, channel_id]);

    let result;
    try {
      result = await flow.start(db, user_id, channel_id, args);
    } catch (err) {
      console.error(`[slash] flow.start(${flowName}) error:`, err);
      await postToSlack(token, channel_id, `Error starting \`${flowName}\`: ${err.message}`);
      return;
    }

    // Modal flow — open a Slack modal
    if (result.modal && result.modalDef) {
      if (!trigger_id) {
        await postToSlack(token, channel_id, '⚠️ Cannot open form: `trigger_id` not provided.');
        return;
      }
      await openSlackModal(token, trigger_id, { flowName, userId: user_id, channelId: channel_id }, result.modalDef);
      return;
    }

    await postToSlack(token, channel_id, result.message);

    if (!result.done) {
      const now = new Date().toISOString();
      await db.run(
        'INSERT INTO conversations (id, user_id, channel_id, flow, step, data, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
        [randomUUID(), user_id, channel_id, flowName, '{}', now, now]
      );
    }
  });

  // ── POST /slash/interactions ────────────────────────────────────────────────

  router.post('/interactions', async (req, res) => {
    if (signingSecret) {
      if (!verifySlackSignature(signingSecret, req.rawBody || '', req.headers)) {
        return res.status(401).send('');
      }
    }

    let payload;
    try { payload = JSON.parse(req.body?.payload || '{}'); }
    catch { return res.status(400).send(''); }

    if (payload.type !== 'view_submission') {
      return res.status(200).json({});
    }

    // Dismiss the modal immediately
    res.status(200).json({});

    const view = payload.view || {};
    let context = {};
    try { context = JSON.parse(view.private_metadata || '{}'); } catch { /* use empty */ }

    const { flowName, channelId } = context;
    const userId = payload.user?.id;

    if (!flowName) {
      console.error('[slash/interactions] Missing flowName in private_metadata');
      return;
    }

    let message;
    try {
      message = await handleModalSubmit(db, flowName, view.state?.values, adapters, scheduler);
    } catch (err) {
      message = `Error saving: ${err.message}`;
    }

    if (message && channelId) {
      await postToSlack(token, channelId, message);
    }
  });

  return router;
}

// ── Conversation reply handler (called from Events API) ───────────────────────

export async function handleConversationReply(db, post, token) {
  const { user_id, channel_id, message } = post;

  const conv = await db.queryOne(
    'SELECT * FROM conversations WHERE user_id=? AND channel_id=?',
    [user_id, channel_id]
  );
  if (!conv) return;

  const updatedAtMs = /^\d+(\.\d+)?$/.test(String(conv.updated_at))
    ? Number(conv.updated_at) * 1000
    : new Date(conv.updated_at).getTime();
  if (Date.now() - updatedAtMs > TTL_MS) {
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  const flow = flows[conv.flow];
  if (!flow) {
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  const convWithData = {
    ...conv,
    data: typeof conv.data === 'string' ? JSON.parse(conv.data || '{}') : (conv.data ?? {}),
  };

  let result;
  try {
    result = await flow.step(db, convWithData, message || '');
  } catch (err) {
    console.error(`[slash] flow.step(${conv.flow}) error:`, err);
    await postToSlack(token, channel_id, `Error: ${err.message}`);
    await db.run('DELETE FROM conversations WHERE id=?', [conv.id]);
    return;
  }

  await postToSlack(token, channel_id, result.message);

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
