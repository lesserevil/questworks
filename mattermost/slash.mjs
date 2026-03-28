/**
 * Slash command router and conversation engine for /qw commands.
 *
 * Entry points:
 *  - createSlashRouter()  — Express router mounted at POST /slash
 *  - handleWebSocketMessage()  — called by bot.mjs WebSocket handler
 *
 * Flow lifecycle:
 *  1. POST /slash creates a conversation at step 0, calls flow.handle() to get first prompt.
 *  2. Conversation state stored in `conversations` table (TTL: 5 min).
 *  3. Subsequent user messages come via WebSocket → handleWebSocketMessage().
 */
import { Router } from 'express';
import express from 'express';
import {
  getActiveConversation,
  createConversation,
  updateConversation,
  deleteConversation,
} from './conversations.mjs';
import { decryptJson, maskToken } from './crypto.mjs';
import { loadAdapterConfigs } from '../db/adapters.mjs';
import { getAllConfig } from '../db/config.mjs';

// ── Flow registry ─────────────────────────────────────────────────────────────
// Each module exports: async handle(ctx) → { reply, step?, data?, done? }

const FLOWS = {
  adapter_add_github: () => import('./flows/adapter_add_github.mjs'),
  adapter_add_beads:  () => import('./flows/adapter_add_beads.mjs'),
  adapter_add_jira:   () => import('./flows/adapter_add_jira.mjs'),
  adapter_remove:     () => import('./flows/adapter_remove.mjs'),
  adapter_sync:       () => import('./flows/adapter_sync.mjs'),
  task_claim:         () => import('./flows/task_claim.mjs'),
  task_done:          () => import('./flows/task_done.mjs'),
  task_block:         () => import('./flows/task_block.mjs'),
  config:             () => import('./flows/config.mjs'),
};

async function loadFlow(name) {
  const loader = FLOWS[name];
  if (!loader) return null;
  return loader();
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatAdapterList(db) {
  const rows = loadAdapterConfigs(db);
  if (!rows.length) return '_No adapters configured. Use `/qw adapter add github` to add one._';

  const lines = [
    '**Configured Adapters:**',
    '| ID | Type | Target | Label/Board | Token | Last Sync | Status |',
    '|---|---|---|---|---|---|---|',
  ];

  for (const row of rows) {
    let target = '—', filter = '—', tokenDisplay = '—';
    try {
      const cfg = decryptJson(row.config_json_encrypted);
      target = cfg.repo || cfg.url || cfg.endpoint || '—';
      filter = cfg.label_filter || cfg.board_id || cfg.project || '—';
      tokenDisplay = cfg.token_masked || '****';
    } catch {}
    const lastSync = row.last_sync_at ? row.last_sync_at.slice(0, 16).replace('T', ' ') : 'never';
    lines.push(`| ${row.id} | ${row.type} | ${target} | ${filter} | ${tokenDisplay} | ${lastSync} | ${row.status} |`);
  }

  return lines.join('\n');
}

function formatTaskList(db) {
  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE status IN ('open','claimed','in_progress') ORDER BY priority DESC, created_at DESC LIMIT 20"
  ).all();
  if (!tasks.length) return '_No open tasks._';

  const lines = [
    '**Open Tasks:**',
    '| # | ID | Title | Source | Priority | Age |',
    '|---|---|---|---|---|---|',
  ];
  tasks.forEach((t, i) => {
    const age = Math.round((Date.now() - new Date(t.created_at).getTime()) / 3600000);
    const ageStr = age < 24 ? `${age}h` : `${Math.round(age / 24)}d`;
    const title = t.title.length > 45 ? t.title.slice(0, 42) + '...' : t.title;
    lines.push(`| ${i + 1} | \`${t.id.slice(0, 8)}\` | ${title} | ${t.source} | ${t.priority} | ${ageStr} |`);
  });

  return lines.join('\n');
}

function formatConfig(db) {
  const cfg = getAllConfig(db);
  if (!Object.keys(cfg).length) return '_No config set. Defaults are in use._';
  return Object.entries(cfg).map(([k, v]) => `**${k}**: ${v}`).join('\n');
}

const HELP_TEXT = `**QuestWorks /qw commands**

**Adapters**
\`/qw adapter add github\` — Add a GitHub issues adapter
\`/qw adapter add beads\`  — Add a Beads board adapter
\`/qw adapter add jira\`   — Add a Jira project adapter
\`/qw adapter list\`       — List all configured adapters
\`/qw adapter remove\`     — Remove an adapter
\`/qw adapter sync\`       — Trigger a manual sync

**Tasks**
\`/qw task list\`   — Show open tasks
\`/qw task claim\`  — Claim a task
\`/qw task done\`   — Mark a task complete
\`/qw task block\`  — Mark a task as blocked

**Config**
\`/qw config set channel\`        — Set notification channel
\`/qw config set sync-interval\`  — Set sync interval
\`/qw config show\`               — Show current config

\`/qw help\`  — This message`;

// ── Core flow runner ──────────────────────────────────────────────────────────
// Supports two flow module styles:
//   Style A: mod.handle(ctx)  → { reply, step?, data?, done? }
//   Style B: mod.start(ctx, conv) + mod.step(ctx, stepNum, message, data)

async function runFlow(flowName, ctx) {
  const mod = await loadFlow(flowName);
  if (!mod) return { reply: `Unknown flow: ${flowName}`, done: true };
  const { conversation, message } = ctx;
  try {
    if (typeof mod.handle === 'function') {
      // Style A
      return await mod.handle(ctx);
    }
    if (typeof mod.start === 'function' && typeof mod.step === 'function') {
      // Style B
      if (conversation.step === 0) {
        const r = await mod.start(ctx, conversation);
        if (r.done) return r;
        return { reply: r.reply, step: r.step ?? 1, data: r.data ?? conversation.data };
      }
      const r = await mod.step(ctx, conversation.step, message, conversation.data);
      if (r.done) return r;
      return { reply: r.reply, step: r.nextStep ?? conversation.step + 1, data: r.newData ?? conversation.data };
    }
    return { reply: 'Flow has no handler.', done: true };
  } catch (err) {
    console.error(`[slash] flow ${flowName} step ${conversation.step} error:`, err.message);
    return { reply: '❌ Something went wrong. Please try the command again.', done: true };
  }
}

function buildCtx(db, adapters, scheduler, notifier, bot, conv, message) {
  return { db, adapters, scheduler, notifier, bot, conversation: conv, message };
}

// ── Slash command router ──────────────────────────────────────────────────────

export function createSlashRouter(db, adapters, scheduler, notifier, bot) {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  router.post('/', async (req, res) => {
    const { user_id, user_name, channel_id, text } = req.body || {};
    if (!user_id || !channel_id) {
      return res.status(400).json({ text: 'Bad request.' });
    }

    const args = (text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rawArgs = (text || '').trim().split(/\s+/).filter(Boolean);

    // ── Immediate responses (no flow) ───────────────────────────────────────
    if (!args.length || args[0] === 'help') {
      return res.json({ response_type: 'ephemeral', text: HELP_TEXT });
    }
    if (args[0] === 'adapter' && args[1] === 'list') {
      return res.json({ response_type: 'in_channel', text: formatAdapterList(db) });
    }
    if (args[0] === 'task' && args[1] === 'list') {
      return res.json({ response_type: 'in_channel', text: formatTaskList(db) });
    }
    if (args[0] === 'config' && args[1] === 'show') {
      return res.json({ response_type: 'in_channel', text: formatConfig(db) });
    }

    // ── Flow routing ────────────────────────────────────────────────────────
    let flowName = null;
    let initialData = { mm_user_id: user_id, mm_user_name: user_name };

    if (args[0] === 'adapter' && args[1] === 'add' && args[2] === 'github') {
      flowName = 'adapter_add_github';
    } else if (args[0] === 'adapter' && args[1] === 'add' && args[2] === 'beads') {
      flowName = 'adapter_add_beads';
    } else if (args[0] === 'adapter' && args[1] === 'add' && args[2] === 'jira') {
      flowName = 'adapter_add_jira';
    } else if (args[0] === 'adapter' && args[1] === 'remove') {
      flowName = 'adapter_remove';
    } else if (args[0] === 'adapter' && args[1] === 'sync') {
      flowName = 'adapter_sync';
    } else if (args[0] === 'task' && args[1] === 'claim') {
      flowName = 'task_claim';
    } else if (args[0] === 'task' && args[1] === 'done') {
      flowName = 'task_done';
    } else if (args[0] === 'task' && args[1] === 'block') {
      flowName = 'task_block';
    } else if (args[0] === 'config' && args[1] === 'set' && args[2] === 'channel') {
      flowName = 'config';
      initialData = { ...initialData, subflow: 'channel' };
    } else if (args[0] === 'config' && args[1] === 'set' && args[2] === 'sync-interval') {
      flowName = 'config';
      initialData = { ...initialData, subflow: 'interval' };
    } else {
      return res.json({ response_type: 'ephemeral', text: `Unknown command. Try \`/qw help\`.` });
    }

    // Create conversation at step 0, run flow to get first prompt
    const conv = createConversation(db, user_id, channel_id, flowName, initialData);
    const ctx = buildCtx(db, adapters, scheduler, notifier, bot, conv, '');
    const result = await runFlow(flowName, ctx);

    if (result.done) {
      deleteConversation(db, conv.id);
    } else {
      updateConversation(db, conv.id, result.step ?? 1, result.data ?? initialData);
    }

    return res.json({ response_type: 'in_channel', text: result.reply || '' });
  });

  return router;
}

// ── WebSocket message handler ─────────────────────────────────────────────────
// Called by the bot WebSocket listener for every incoming user message.

export async function handleWebSocketMessage(db, adapters, scheduler, notifier, bot, userId, channelId, text) {
  const conv = getActiveConversation(db, userId, channelId);
  if (!conv) return; // No active conversation — ignore

  const ctx = buildCtx(db, adapters, scheduler, notifier, bot, conv, text);
  const result = await runFlow(conv.flow, ctx);

  if (result.done) {
    deleteConversation(db, conv.id);
  } else {
    updateConversation(db, conv.id, result.step ?? conv.step, result.data ?? conv.data);
  }

  if (result.reply) {
    if (bot?.enabled) {
      await bot.post(channelId, result.reply);
    } else if (notifier?.enabled) {
      await notifier.postMessage(channelId, result.reply);
    }
  }
}
