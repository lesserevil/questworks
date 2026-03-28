#!/usr/bin/env node
/**
 * webhook-handler.mjs
 *
 * Mattermost slash command webhook handler for QuestWorks workqueue.
 * Handles POST /job commands from Mattermost and reads/writes queue.json.
 *
 * Commands:
 *   /job list [--status <s>] [--assignee <a>] [--priority <p>] [--all]
 *   /job create <title> [--priority <p>] [--assignee <a>] [--desc <d>] [--tags <t,t>]
 *   /job claim <id>
 *   /job update <id> <field> <value>
 *   /job complete <id> [--result <text>]
 *
 * Usage:
 *   node webhook-handler.mjs [--port 3000] [--queue path/to/queue.json] [--token <mm-token>]
 */

import express from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKQUEUE_DIR = resolve(__dirname, '..');

// ── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cliArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const PORT = parseInt(cliArg('--port') || process.env.PORT || '3000', 10);
const QUEUE_PATH = cliArg('--queue') || process.env.QUEUE_PATH || resolve(WORKQUEUE_DIR, 'queue.json');
const MATTERMOST_TOKEN = cliArg('--token') || process.env.MATTERMOST_TOKEN || null;

const VALID_PRIORITIES = ['urgent', 'high', 'normal', 'low', 'idea'];
const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'blocked', 'deferred'];
const PRIORITY_SORT = { urgent: 0, high: 1, normal: 2, low: 3, idea: 4 };

// ── Queue I/O ─────────────────────────────────────────────────────────────────

function loadQueue() {
  try {
    return JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read queue.json: ${e.message}`);
  }
}

function saveQueue(queue) {
  queue.lastSync = new Date().toISOString();
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n', 'utf8');
}

// ── ID generation ─────────────────────────────────────────────────────────────

function nextId(queue) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `wq-${today}-`;
  const allItems = [...(queue.items || []), ...(queue.completed || [])];
  const existing = allItems
    .map(i => i.id)
    .filter(id => id.startsWith(prefix))
    .map(id => parseInt(id.slice(prefix.length), 10))
    .filter(n => !isNaN(n));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

// ── Argument parser ───────────────────────────────────────────────────────────
// Parses a Mattermost command text string into positional args + --flag values.
// Quoted strings ("foo bar") are kept together.

function parseArgs(text) {
  const tokens = [];
  const re = /"([^"]*)"|(--\S+)|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[0]);
  }

  const positional = [];
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].startsWith('--')) {
      const key = tokens[i].slice(2);
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        flags[key] = tokens[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(tokens[i]);
    }
  }
  return { positional, flags };
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(text) {
  return { response_type: 'in_channel', text };
}

function err(text) {
  // ephemeral so only the caller sees the error
  return { response_type: 'ephemeral', text: `**Error:** ${text}` };
}

function help() {
  return ok([
    '**QuestWorks Job Queue** — available commands:',
    '• `/job list` — list active items _(options: `--status`, `--assignee`, `--priority`, `--all`)_',
    '• `/job create <title>` — create new item _(options: `--priority`, `--assignee`, `--desc`, `--tags`)_',
    '• `/job claim <id>` — claim an item',
    '• `/job update <id> <field> <value>` — update a field _(status, priority, notes, assignee, title)_',
    '• `/job complete <id>` — mark complete _(option: `--result`)_',
  ].join('\n'));
}

// ── Formatters ────────────────────────────────────────────────────────────────

const PRIORITY_EMOJI = { urgent: '🔴', high: '🟠', normal: '🟡', low: '🔵', idea: '💡' };
const STATUS_EMOJI   = { pending: '⏳', in_progress: '⚙️', completed: '✅', failed: '❌', blocked: '🚧', deferred: '💤' };

function fmtItem(item) {
  const p = PRIORITY_EMOJI[item.priority] || '•';
  const s = STATUS_EMOJI[item.status] || '?';
  const claimed = item.claimedBy ? ` _(claimed by ${item.claimedBy})_` : '';
  return `${p} ${s} **${item.id}** — ${item.title} [${item.assignee}]${claimed}`;
}

function fmtDetail(item) {
  const lines = [
    `**${item.id}** — ${item.title}`,
    `Status: ${STATUS_EMOJI[item.status] || ''} ${item.status} | Priority: ${PRIORITY_EMOJI[item.priority] || ''} ${item.priority}`,
    `Assignee: ${item.assignee} | Source: ${item.source}`,
    `Created: ${item.created}`,
  ];
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.tags?.length) lines.push(`Tags: ${item.tags.join(', ')}`);
  if (item.claimedBy) lines.push(`Claimed by: ${item.claimedBy} at ${item.claimedAt}`);
  if (item.notes) lines.push(`Notes: ${item.notes}`);
  if (item.result) lines.push(`Result: ${item.result}`);
  return lines.join('\n');
}

// ── Command handlers ──────────────────────────────────────────────────────────

function cmdList({ positional, flags }, _user) {
  const queue = loadQueue();
  let items = queue.items || [];

  if (!flags.all) {
    // By default exclude completed/failed from items array (shouldn't be there, but guard)
    items = items.filter(i => !['completed', 'failed'].includes(i.status));
  }

  if (flags.status) {
    const s = flags.status.toLowerCase();
    if (!VALID_STATUSES.includes(s)) return err(`Unknown status: ${s}. Valid: ${VALID_STATUSES.join(', ')}`);
    items = items.filter(i => i.status === s);
  }
  if (flags.assignee) {
    items = items.filter(i => i.assignee === flags.assignee || i.claimedBy === flags.assignee);
  }
  if (flags.priority) {
    const p = flags.priority.toLowerCase();
    if (!VALID_PRIORITIES.includes(p)) return err(`Unknown priority: ${p}. Valid: ${VALID_PRIORITIES.join(', ')}`);
    items = items.filter(i => i.priority === p);
  }

  // Sort: priority order, then created asc
  items.sort((a, b) => {
    const pd = (PRIORITY_SORT[a.priority] ?? 99) - (PRIORITY_SORT[b.priority] ?? 99);
    return pd !== 0 ? pd : a.created.localeCompare(b.created);
  });

  if (items.length === 0) return ok('No items match your query.');

  const lines = [`**Queue** (${items.length} item${items.length !== 1 ? 's' : ''}):`, ...items.map(fmtItem)];
  return ok(lines.join('\n'));
}

function cmdCreate({ positional, flags }, user) {
  // positional[0] is the subcommand 'create', rest is title unless --flags capture it
  const titleParts = positional.slice(1);
  const title = titleParts.join(' ').trim() || flags.title;
  if (!title) return err('Usage: `/job create <title>` [--priority p] [--assignee a] [--desc d] [--tags t1,t2]');

  const priority = (flags.priority || 'normal').toLowerCase();
  if (!VALID_PRIORITIES.includes(priority)) return err(`Unknown priority: ${priority}. Valid: ${VALID_PRIORITIES.join(', ')}`);

  const assignee = flags.assignee || 'all';
  const description = flags.desc || flags.description || undefined;
  const tags = flags.tags ? flags.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

  const queue = loadQueue();
  const id = nextId(queue);
  const now = new Date().toISOString();

  const item = {
    id,
    itemVersion: 1,
    created: now,
    source: user,
    assignee,
    priority,
    status: 'pending',
    title,
    description: description || null,
    notes: null,
    tags,
    votes: [user],
    claimedBy: null,
    claimedAt: null,
    attempts: 0,
    maxAttempts: 3,
    lastAttempt: null,
    completedAt: null,
    result: null,
    channel: 'mattermost',
  };

  queue.items.push(item);
  saveQueue(queue);

  return ok(`${PRIORITY_EMOJI[priority]} Created **${id}**: ${title} [${assignee}]`);
}

function cmdClaim({ positional, flags }, user) {
  const id = positional[1];
  if (!id) return err('Usage: `/job claim <id>`');

  const queue = loadQueue();
  const item = queue.items.find(i => i.id === id);
  if (!item) return err(`Item not found: ${id}`);

  if (item.claimedBy) {
    // Check staleness (>15 min)
    const age = item.claimedAt ? Date.now() - new Date(item.claimedAt).getTime() : Infinity;
    if (age <= 15 * 60 * 1000) {
      return err(`**${id}** is already claimed by ${item.claimedBy}. Claim is ${Math.round(age / 60000)}m old.`);
    }
    // Stale claim — allow override
  }

  const now = new Date().toISOString();
  item.claimedBy = user;
  item.claimedAt = now;
  item.status = 'in_progress';
  item.lastAttempt = now;
  item.attempts += 1;
  item.itemVersion += 1;

  saveQueue(queue);
  return ok(`${STATUS_EMOJI.in_progress} **${id}** claimed by @${user}: _${item.title}_`);
}

function cmdUpdate({ positional, flags }, user) {
  // /job update <id> <field> <value...>
  const id = positional[1];
  const field = positional[2];
  const value = positional.slice(3).join(' ').trim() || flags.value;

  if (!id || !field || value === undefined || value === '') {
    return err('Usage: `/job update <id> <field> <value>` — fields: status, priority, notes, assignee, title');
  }

  const MUTABLE_FIELDS = ['status', 'priority', 'notes', 'assignee', 'title', 'result', 'description'];
  if (!MUTABLE_FIELDS.includes(field)) {
    return err(`Cannot update field: ${field}. Mutable fields: ${MUTABLE_FIELDS.join(', ')}`);
  }

  const queue = loadQueue();
  let item = queue.items.find(i => i.id === id) || queue.completed.find(i => i.id === id);
  if (!item) return err(`Item not found: ${id}`);

  // Validate enum fields
  if (field === 'status') {
    const s = value.toLowerCase();
    if (!VALID_STATUSES.includes(s)) return err(`Unknown status: ${s}. Valid: ${VALID_STATUSES.join(', ')}`);

    // Moving to completed/failed: enforce result requirement
    if ((s === 'completed' || s === 'failed') && !item.result && !flags.result) {
      return err(`Set a result before marking ${s}: \`/job update ${id} result <text>\``);
    }

    if (s === 'completed' || s === 'failed') {
      item.completedAt = item.completedAt || new Date().toISOString();
      // Move from items → completed if currently in items
      const idx = queue.items.indexOf(item);
      if (idx !== -1) {
        queue.items.splice(idx, 1);
        queue.completed.push(item);
      }
    }
    item.status = s;
  } else if (field === 'priority') {
    const p = value.toLowerCase();
    if (!VALID_PRIORITIES.includes(p)) return err(`Unknown priority: ${p}. Valid: ${VALID_PRIORITIES.join(', ')}`);
    item.priority = p;
  } else if (field === 'notes') {
    const ts = new Date().toISOString();
    item.notes = item.notes ? `${item.notes}\n[${ts}] @${user}: ${value}` : `[${ts}] @${user}: ${value}`;
  } else {
    item[field] = value;
  }

  item.itemVersion += 1;
  saveQueue(queue);

  return ok(`Updated **${id}** — ${field} → \`${field === 'notes' ? '(appended)' : value}\``);
}

function cmdComplete({ positional, flags }, user) {
  const id = positional[1];
  if (!id) return err('Usage: `/job complete <id>` [--result <text>]');

  const result = flags.result || positional.slice(2).join(' ').trim() || 'Completed via Mattermost';

  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) {
    // Already in completed?
    const done = queue.completed.find(i => i.id === id);
    if (done) return err(`**${id}** is already ${done.status}.`);
    return err(`Item not found: ${id}`);
  }

  const item = queue.items[idx];
  const now = new Date().toISOString();
  item.status = 'completed';
  item.result = result;
  item.completedAt = now;
  item.itemVersion += 1;

  queue.items.splice(idx, 1);
  queue.completed.push(item);
  saveQueue(queue);

  return ok(`${STATUS_EMOJI.completed} **${id}** completed: _${item.title}_\nResult: ${result}`);
}

function cmdShow({ positional }, _user) {
  const id = positional[1];
  if (!id) return err('Usage: `/job show <id>`');

  const queue = loadQueue();
  const item = [...(queue.items || []), ...(queue.completed || [])].find(i => i.id === id);
  if (!item) return err(`Item not found: ${id}`);

  return ok(fmtDetail(item));
}

// ── Route ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/job', (req, res) => {
  const { token, text = '', user_name = 'unknown', channel_name } = req.body;

  // Token validation (optional but recommended in production)
  if (MATTERMOST_TOKEN && token !== MATTERMOST_TOKEN) {
    return res.status(401).json({ response_type: 'ephemeral', text: 'Unauthorized.' });
  }

  const parsed = parseArgs(text.trim());
  const subcommand = parsed.positional[0]?.toLowerCase();

  let response;
  try {
    switch (subcommand) {
      case 'list':    response = cmdList(parsed, user_name);     break;
      case 'create':  response = cmdCreate(parsed, user_name);   break;
      case 'claim':   response = cmdClaim(parsed, user_name);    break;
      case 'update':  response = cmdUpdate(parsed, user_name);   break;
      case 'complete':response = cmdComplete(parsed, user_name); break;
      case 'show':    response = cmdShow(parsed, user_name);     break;
      case 'help':
      case undefined: response = help();                         break;
      default:        response = err(`Unknown subcommand: ${subcommand}. Try \`/job help\`.`);
    }
  } catch (e) {
    console.error(`[webhook] Error handling /${subcommand} from ${user_name}:`, e);
    response = err(`Internal error: ${e.message}`);
  }

  console.log(`[webhook] ${user_name} in #${channel_name}: /job ${text.trim().slice(0, 80)} → ${response.response_type}`);
  res.json(response);
});

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, queue: QUEUE_PATH }));

// ── REST API ──────────────────────────────────────────────────────────────────

// GET /api/queue — full queue JSON
app.get('/api/queue', (_req, res) => {
  try {
    res.json(loadQueue());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/queue/items — active items array
app.get('/api/queue/items', (_req, res) => {
  try {
    const queue = loadQueue();
    res.json(queue.items || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/queue/item/:id — single item (searches items + completed)
app.get('/api/queue/item/:id', (req, res) => {
  try {
    const queue = loadQueue();
    const item = [...(queue.items || []), ...(queue.completed || [])].find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: `Item not found: ${req.params.id}` });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/queue/item — create item
app.post('/api/queue/item', (req, res) => {
  try {
    const { title, description, priority = 'normal', assignee = 'all', tags = [] } = req.body || {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Missing required field: title' });
    }
    const p = priority.toLowerCase();
    if (!VALID_PRIORITIES.includes(p)) {
      return res.status(400).json({ error: `Invalid priority: ${p}. Valid: ${VALID_PRIORITIES.join(', ')}` });
    }
    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array' });
    }

    const queue = loadQueue();
    const id = nextId(queue);
    const now = new Date().toISOString();

    const item = {
      id,
      itemVersion: 1,
      created: now,
      source: 'api',
      assignee: String(assignee),
      priority: p,
      status: 'pending',
      title: title.trim(),
      description: description ? String(description) : null,
      notes: null,
      tags: tags.map(t => String(t).trim()).filter(Boolean),
      votes: [],
      claimedBy: null,
      claimedAt: null,
      attempts: 0,
      maxAttempts: 3,
      lastAttempt: null,
      completedAt: null,
      result: null,
      channel: 'api',
    };

    queue.items.push(item);
    saveQueue(queue);

    console.log(`[api] POST /api/queue/item → created ${id}`);
    res.status(200).json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/queue/item/:id — update fields on an item
app.put('/api/queue/item/:id', (req, res) => {
  try {
    const MUTABLE_FIELDS = ['status', 'priority', 'notes', 'assignee', 'title', 'result', 'description', 'tags'];
    const updates = req.body || {};
    const id = req.params.id;

    const badFields = Object.keys(updates).filter(f => !MUTABLE_FIELDS.includes(f));
    if (badFields.length) {
      return res.status(400).json({ error: `Immutable or unknown fields: ${badFields.join(', ')}. Mutable: ${MUTABLE_FIELDS.join(', ')}` });
    }

    if ('status' in updates) {
      const s = String(updates.status).toLowerCase();
      if (!VALID_STATUSES.includes(s)) {
        return res.status(400).json({ error: `Invalid status: ${s}. Valid: ${VALID_STATUSES.join(', ')}` });
      }
      updates.status = s;
    }
    if ('priority' in updates) {
      const p = String(updates.priority).toLowerCase();
      if (!VALID_PRIORITIES.includes(p)) {
        return res.status(400).json({ error: `Invalid priority: ${p}. Valid: ${VALID_PRIORITIES.join(', ')}` });
      }
      updates.priority = p;
    }
    if ('tags' in updates && !Array.isArray(updates.tags)) {
      return res.status(400).json({ error: 'tags must be an array' });
    }

    const queue = loadQueue();
    let item = queue.items.find(i => i.id === id) || queue.completed.find(i => i.id === id);
    if (!item) return res.status(404).json({ error: `Item not found: ${id}` });

    // Handle status transitions that move item to completed array
    if ('status' in updates && (updates.status === 'completed' || updates.status === 'failed')) {
      item.completedAt = item.completedAt || new Date().toISOString();
      const idx = queue.items.indexOf(item);
      if (idx !== -1) {
        queue.items.splice(idx, 1);
        queue.completed.push(item);
      }
    }

    Object.assign(item, updates);
    item.itemVersion += 1;
    saveQueue(queue);

    console.log(`[api] PUT /api/queue/item/${id} → updated fields: ${Object.keys(updates).join(', ')}`);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/queue/item/:id/claim — claim an item
app.post('/api/queue/item/:id/claim', (req, res) => {
  try {
    const { agent } = req.body || {};
    const id = req.params.id;

    if (!agent || typeof agent !== 'string' || !agent.trim()) {
      return res.status(400).json({ error: 'Missing required field: agent' });
    }

    const queue = loadQueue();
    const item = queue.items.find(i => i.id === id);
    if (!item) {
      const done = queue.completed?.find(i => i.id === id);
      if (done) return res.status(400).json({ error: `Item ${id} is already ${done.status}` });
      return res.status(404).json({ error: `Item not found: ${id}` });
    }

    if (item.claimedBy) {
      const age = item.claimedAt ? Date.now() - new Date(item.claimedAt).getTime() : Infinity;
      if (age <= 15 * 60 * 1000) {
        return res.status(400).json({ error: `Item ${id} is already claimed by ${item.claimedBy} (${Math.round(age / 60000)}m ago)` });
      }
    }

    const now = new Date().toISOString();
    item.claimedBy = agent.trim();
    item.claimedAt = now;
    item.status = 'in_progress';
    item.lastAttempt = now;
    item.attempts += 1;
    item.itemVersion += 1;

    saveQueue(queue);

    console.log(`[api] POST /api/queue/item/${id}/claim → claimed by ${agent}`);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/queue/item/:id/complete — complete an item
app.post('/api/queue/item/:id/complete', (req, res) => {
  try {
    const { result } = req.body || {};
    const id = req.params.id;

    if (!result || typeof result !== 'string' || !result.trim()) {
      return res.status(400).json({ error: 'Missing required field: result' });
    }

    const queue = loadQueue();
    const idx = queue.items.findIndex(i => i.id === id);
    if (idx === -1) {
      const done = queue.completed?.find(i => i.id === id);
      if (done) return res.status(400).json({ error: `Item ${id} is already ${done.status}` });
      return res.status(404).json({ error: `Item not found: ${id}` });
    }

    const item = queue.items[idx];
    const now = new Date().toISOString();
    item.status = 'completed';
    item.result = result.trim();
    item.completedAt = now;
    item.itemVersion += 1;

    queue.items.splice(idx, 1);
    queue.completed.push(item);
    saveQueue(queue);

    console.log(`[api] POST /api/queue/item/${id}/complete`);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[webhook] QuestWorks job handler listening on :${PORT}`);
  console.log(`[webhook] Queue: ${QUEUE_PATH}`);
  if (!MATTERMOST_TOKEN) console.warn('[webhook] WARNING: MATTERMOST_TOKEN not set — token validation disabled');
});
