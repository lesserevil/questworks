/**
 * Slack Events API handler.
 *
 * Exports:
 *   createEventsRouter(db, handleConversationReply, slackOpts)
 *     — Express router mounted at /slack
 *     — POST /slack/events  → Slack event callbacks (URL verification + message events)
 *
 * Slack app configuration:
 *   Event Subscriptions → Request URL: https://<host>/slack/events
 *   Subscribe to bot events: message.channels, message.groups, message.im
 */
import { Router } from 'express';
import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

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

export function createEventsRouter(db, handleConversationReply, { token = '', signingSecret = '' } = {}) {
  const router = Router();

  // Capture raw body for signature verification before JSON parsing
  router.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
  }));

  router.post('/events', async (req, res) => {
    if (signingSecret) {
      if (!verifySlackSignature(signingSecret, req.rawBody || '', req.headers)) {
        return res.status(401).send('');
      }
    }

    const body = req.body || {};

    // Slack URL verification challenge (first-time setup)
    if (body.type === 'url_verification') {
      return res.json({ challenge: body.challenge });
    }

    // Acknowledge all other events immediately
    res.status(200).json({});

    if (body.type !== 'event_callback') return;

    const event = body.event;
    if (!event) return;

    // Only handle plain user messages (not bot posts, edits, deletes, etc.)
    if (event.type !== 'message') return;
    if (event.subtype) return;       // edited, deleted, bot_message, etc.
    if (event.bot_id) return;        // bot message
    if (!event.user || !event.channel || !event.text) return;

    await handleConversationReply(db, {
      user_id: event.user,
      channel_id: event.channel,
      message: event.text,
    }, token).catch(err => console.error('[events] handleConversationReply error:', err.message));
  });

  return router;
}
