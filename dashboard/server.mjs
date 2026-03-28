#!/usr/bin/env node
/**
 * WQ Dashboard — Dr. Quest's unified workqueue + QuestBus dashboard
 * Port 8788, dark theme, live data, client-side rendering
 */

import express from 'express';
import { readFile, writeFile, appendFile } from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { createReadStream as createRS } from 'fs';
import { initCrashReporter } from '../lib/crash-reporter.mjs';

// Initialize crash reporter early — before anything else can throw
initCrashReporter({
  service: 'wq-dashboard',
  sourceDir: process.env.DASHBOARD_SOURCE_DIR || new URL('.', import.meta.url).pathname,
});

const execFileP = promisify(execFile);

const app = express();
const PORT = 8788;
const AUTH_TOKEN = process.env.QUESTWORKS_TOKEN || 'questworks-2026';
const QUEUE_PATH = process.env.QUEUE_PATH || new URL('../workqueue/queue.json', import.meta.url).pathname;
const MC_PATH = process.env.MC_PATH || 'mc';
const MINIO_ALIAS = process.env.MINIO_ALIAS || 'do-host1';
const BUS_LOG_PATH = process.env.BUS_LOG_PATH || new URL('../questbus/bus.jsonl', import.meta.url).pathname;

// ── QuestBus peer fan-out registry ─────────────────────────────────────────
const BUS_PEERS = {
  race: 'http://quest-mattermost.eastus.azurecontainer.io:18789/questbus/receive',
  hadji:    'http://quest-mattermost.eastus.azurecontainer.io:18789/questbus/receive',
};
const BULLWINKLE_TOKEN = process.env.BULLWINKLE_TOKEN || 'clawmeh';
const NATASHA_TOKEN    = process.env.NATASHA_TOKEN    || 'clawmeh';
const PEER_TOKENS = { race: BULLWINKLE_TOKEN, hadji: NATASHA_TOKEN };

async function fanOutBusMessage(msg) {
  for (const [peer, url] of Object.entries(BUS_PEERS)) {
    // Skip fan-out back to the originating agent
    if (msg.from === peer) continue;
    // Only fan out if addressed to this peer or to 'all'
    if (msg.to !== 'all' && msg.to !== peer) continue;

    const token = PEER_TOKENS[peer];
    (async () => {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(msg),
          signal: ctrl.signal,
        });
        clearTimeout(timeout);
        console.log(`[bus-fanout] → ${peer}: HTTP ${resp.status}`);
      } catch (err) {
        console.warn(`[bus-fanout] → ${peer}: failed (${err.message})`);
      }
    })();
  }
}

// Middleware
app.use(express.json());

// CORS for API endpoints
app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Auth middleware for write endpoints
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Data helpers ---

async function readQueue() {
  const raw = await readFile(QUEUE_PATH, 'utf8');
  return JSON.parse(raw);
}

async function writeQueue(data) {
  await writeFile(QUEUE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// In-memory heartbeat store
const heartbeats = {};

async function fetchMinIOHeartbeat(agent) {
  try {
    const { stdout } = await execFileP(MC_PATH, [
      'cat', `${MINIO_ALIAS}/agents/shared/agent-heartbeat-${agent}.json`
    ], { timeout: 5000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function getHeartbeats() {
  const agents = ['drquest', 'race', 'hadji'];
  const result = {};
  for (const agent of agents) {
    if (heartbeats[agent]) {
      result[agent] = heartbeats[agent];
    } else {
      const minio = await fetchMinIOHeartbeat(agent);
      if (minio) result[agent] = minio;
      else result[agent] = { agent, status: 'unknown', ts: null };
    }
  }
  return result;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- API Routes ---

app.get('/api/queue', async (req, res) => {
  try {
    const data = await readQueue();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/heartbeats', async (req, res) => {
  try {
    const hbs = await getHeartbeats();
    res.json(hbs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upvote/:id', requireAuth, async (req, res) => {
  try {
    const data = await readQueue();
    const item = data.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.status !== 'idea') return res.status(400).json({ error: 'Only idea items can be promoted' });
    item.status = 'pending';
    item.notes = (item.notes || '') + `\nPromoted to task by dashboard at ${new Date().toISOString()} (upvote).`;
    item.itemVersion = (item.itemVersion || 0) + 1;
    if (!item.votes) item.votes = [];
    item.votes.push('dashboard');
    await writeQueue(data);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/comment/:id', requireAuth, async (req, res) => {
  try {
    const data = await readQueue();
    const idx = data.items.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Item not found' });
    const item = data.items[idx];
    const text = (req.body.text || '').trim().toLowerCase();
    const rawText = (req.body.text || '').trim();

    if (text === 'delete' || text === 'remove') {
      data.items.splice(idx, 1);
      await writeQueue(data);
      return res.json({ ok: true, action: 'deleted', id: req.params.id });
    }

    if (text.startsWith('break into') || text.includes('subtask')) {
      item.status = 'pending';
      item.notes = (item.notes || '') + `\n[Subtask note] ${rawText} — added at ${new Date().toISOString()}`;
      item.itemVersion = (item.itemVersion || 0) + 1;
      await writeQueue(data);
      return res.json({ ok: true, action: 'subtasked', item });
    }

    if (item.status === 'blocked') item.status = 'pending';
    item.notes = (item.notes || '') + `\n[Comment] ${rawText} — added at ${new Date().toISOString()}`;
    item.itemVersion = (item.itemVersion || 0) + 1;
    await writeQueue(data);
    res.json({ ok: true, action: 'commented', item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/complete/:id', requireAuth, async (req, res) => {
  try {
    const data = await readQueue();
    const item = data.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    item.itemVersion = (item.itemVersion || 0) + 1;
    await writeQueue(data);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/heartbeat/:agent', requireAuth, async (req, res) => {
  const agent = req.params.agent;
  heartbeats[agent] = {
    agent,
    ts: new Date().toISOString(),
    status: 'online',
    ...req.body,
  };
  res.json({ ok: true });
});

// --- Crash Report API ---

app.post('/api/crash-report', requireAuth, async (req, res) => {
  try {
    const { service, error, stack, sourceDir, ts } = req.body;
    if (!service || !error) {
      return res.status(400).json({ error: 'Missing required fields: service, error' });
    }

    const timestamp = ts || String(Date.now());
    const truncTitle = (error || 'Unknown error').slice(0, 80);
    const stackLines = (stack || '').split('\n').slice(0, 5).join('\n');
    const minioPath = `agents/logs/${service}-crash-${timestamp}.json`;

    const task = {
      id: `wq-crash-${timestamp}`,
      itemVersion: 1,
      created: new Date(parseInt(timestamp)).toISOString(),
      source: 'system',
      assignee: 'all',
      priority: 'high',
      status: 'pending',
      title: `CRASH: ${service} — ${truncTitle}`,
      description: `Unhandled exception in ${service}. Stack trace and logs available.`,
      notes: `Error: ${error}\nStack: ${stackLines}\nSource: ${sourceDir || 'unknown'}\nMinIO logs: ${minioPath}`,
      tags: ['crash', 'auto-filed', service],
      channel: 'mattermost',
      claimedBy: null,
      claimedAt: null,
      attempts: 0,
      maxAttempts: 1,
      lastAttempt: null,
      completedAt: null,
      result: null,
    };

    const data = await readQueue();
    data.items = data.items || [];
    data.items.push(task);
    data.lastSync = new Date().toISOString();
    await writeQueue(data);

    console.log(`[crash-report] Filed crash task ${task.id} for ${service}`);
    res.json({ ok: true, taskId: task.id });
  } catch (e) {
    console.error(`[crash-report] Error filing crash: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// --- Unified Dashboard HTML ---

function renderUnifiedPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🐿️ Dr. Quest Command Center</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
    a { color: #58a6ff; text-decoration: none; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .section-header { font-size: 18px; font-weight: 700; color: #f0f6fc; padding: 12px 0 8px 0; border-bottom: 1px solid #21262d; margin-bottom: 12px; }
    .section { margin-bottom: 28px; }

    /* Agent cards */
    .agent-cards { display: flex; gap: 12px; flex-wrap: wrap; }
    .agent-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; flex: 1; min-width: 200px; max-height: 110px; }
    .agent-name { font-size: 17px; font-weight: 700; margin-bottom: 4px; }
    .agent-meta { color: #8b949e; font-size: 12px; margin-top: 2px; }
    .status-online { color: #3fb950; font-weight: 600; }
    .status-stale { color: #d29922; font-weight: 600; }
    .status-offline { color: #f85149; font-weight: 600; }

    /* Queue table */
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 10px; color: #8b949e; font-size: 12px; border-bottom: 1px solid #30363d; }
    td { padding: 8px 10px; }
    tbody tr { border-bottom: 1px solid #21262d; }
    tbody tr:hover { background: #161b22; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; color: #fff; }
    .pill-pending { background: #1f6feb; }
    .pill-in-progress { background: #a371f7; }
    .pill-blocked { background: #f85149; }
    .pill-deferred { background: #8b949e; }
    .pill-completed { background: #3fb950; }
    .pill-idea { background: #d29922; }
    .filter-bar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
    .filter-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 12px; border-radius: 16px; cursor: pointer; font-size: 12px; }
    .filter-btn.active { background: #1f6feb !important; color: #fff !important; border-color: #1f6feb !important; }
    .q-table-wrap { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow-x: auto; }
    .action-btn { border: none; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; color: #fff; margin: 1px; }
    .action-btn.promote { background: #1f6feb; }
    .action-btn.complete { background: #238636; }
    .action-btn.comment { background: #d29922; }
    .cmt-input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; padding: 3px 6px; border-radius: 4px; font-size: 11px; width: 110px; }

    /* Bus messages */
    .bus-filters { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
    .bus-filter-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 12px; border-radius: 16px; cursor: pointer; font-size: 12px; }
    .bus-filter-btn.active { background: #1f6feb !important; color: #fff !important; border-color: #1f6feb !important; }
    .bus-msg { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 14px; margin-bottom: 6px; }
    .bus-msg.compact { background: transparent; border: none; padding: 4px 14px; margin-bottom: 2px; color: #484f58; font-size: 12px; }
    .bus-msg.hidden { display: none; }
    .bus-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 13px; }
    .type-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; color: #fff; margin-left: 4px; }

    /* Send form */
    .send-form { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
    .send-form summary { cursor: pointer; font-weight: 600; color: #58a6ff; font-size: 13px; }
    .send-form input, .send-form textarea, .send-form select { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 8px; border-radius: 4px; font-size: 12px; }
    .send-form textarea { width: 100%; resize: vertical; min-height: 50px; }
    .send-btn { background: #238636; color: #fff; border: none; padding: 5px 14px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px; }
    .send-btn:hover { background: #2ea043; }

    /* Toast */
    .toast { position: fixed; bottom: 20px; right: 20px; background: #238636; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; display: none; z-index: 999; }
    .toast.error { background: #f85149; }

    /* Footer */
    .footer { color: #484f58; font-size: 11px; text-align: center; margin-top: 16px; padding-top: 12px; border-top: 1px solid #21262d; }
  </style>
</head>
<body>
  <div class="container">
    <h1 style="font-size:24px;margin-bottom:20px;color:#f0f6fc">🐿️ Dr. Quest Command Center</h1>

    <!-- Section 1: Agent Status -->
    <div class="section">
      <div class="section-header">🟢 Agent Status</div>
      <div class="agent-cards" id="agent-cards">
        <div class="agent-card"><span class="agent-meta">Loading...</span></div>
      </div>
    </div>

    <!-- Section 2: Work Queue -->
    <div class="section">
      <div class="section-header">📋 Work Queue</div>
      <div class="filter-bar" id="queue-filters"></div>
      <div class="q-table-wrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Title / Description</th><th>Assignee</th><th>Priority</th><th>Actions</th></tr>
          </thead>
          <tbody id="queue-body">
            <tr><td colspan="5" style="padding:16px;color:#8b949e">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Section 3: QuestBus -->
    <div class="section">
      <div class="section-header">📡 QuestBus</div>
      <details class="send-form">
        <summary>✉️ Send a message</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px">
          <div><label style="font-size:11px;color:#8b949e">From</label><select id="msg-from" style="width:100%"><option value="drquest">Dr. Quest</option><option value="jkh">jkh</option></select></div>
          <div><label style="font-size:11px;color:#8b949e">To</label><select id="msg-to" style="width:100%"><option value="all">All</option><option value="drquest">Dr. Quest</option><option value="race">Race</option><option value="hadji">Hadji</option><option value="jkh">jkh</option></select></div>
          <div><label style="font-size:11px;color:#8b949e">Type</label><select id="msg-type" style="width:100%"><option value="text">text</option><option value="memo">memo</option></select></div>
        </div>
        <div style="margin-top:6px"><label style="font-size:11px;color:#8b949e">Subject</label><input id="msg-subject" style="width:100%" placeholder="Optional subject..."></div>
        <div style="margin-top:6px"><label style="font-size:11px;color:#8b949e">Body</label><textarea id="msg-body" placeholder="Type your message..."></textarea></div>
        <div style="margin-top:6px;text-align:right"><button class="send-btn" onclick="sendBusMessage()">Send</button></div>
      </details>
      <div class="bus-filters" id="bus-filters"></div>
      <div id="bus-messages"><div style="color:#8b949e;padding:12px">Loading messages...</div></div>
    </div>

    <div class="footer" id="footer">Loading...</div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    // === Token management ===
    function getToken() {
      let t = localStorage.getItem('wq-token');
      if (!t) {
        t = prompt('Enter auth token:');
        if (t) localStorage.setItem('wq-token', t);
      }
      return t;
    }
    function showToast(msg, isError) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast' + (isError ? ' error' : '');
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 3000);
    }

    // === Helpers ===
    function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function timeAgo(ds) {
      if (!ds) return 'never';
      const diff = Date.now() - new Date(ds).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return m + 'm ago';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    }
    const EMOJIS = { drquest: '🐿️', race: '🫎', hadji: '🕵️‍♀️', jkh: '👤' };
    const TYPE_COLORS = { text: '#58a6ff', memo: '#3fb950', blob: '#a371f7', heartbeat: '#8b949e', queue_sync: '#d29922', ping: '#3fb950', pong: '#3fb950', event: '#f85149', handoff: '#f0883e' };

    // === Section 1: Agent Cards ===
    async function loadAgents() {
      try {
        const hbs = await fetch('/api/heartbeats').then(r => r.json());
        const el = document.getElementById('agent-cards');
        el.innerHTML = ['drquest', 'race', 'hadji'].map(name => {
          const hb = hbs[name] || {};
          const emoji = EMOJIS[name] || '📨';
          let stClass = 'status-offline', stEmoji = '🔴', stLabel = 'offline';
          if (hb.ts) {
            const age = Date.now() - new Date(hb.ts).getTime();
            if (age < 45 * 60 * 1000) { stClass = 'status-online'; stEmoji = '🟢'; stLabel = 'online'; }
            else if (age < 4 * 60 * 60 * 1000) { stClass = 'status-stale'; stEmoji = '🟡'; stLabel = 'stale'; }
          }
          const host = hb.host || '—';
          const lastSeen = timeAgo(hb.ts);
          const queueDepth = hb.queueDepth != null ? '<div class="agent-meta">Queue: ' + hb.queueDepth + ' items</div>' : '';
          return '<div class="agent-card">' +
            '<div class="agent-name">' + emoji + ' ' + name.charAt(0).toUpperCase() + name.slice(1) + '</div>' +
            '<div class="' + stClass + '">' + stEmoji + ' ' + stLabel + '</div>' +
            '<div class="agent-meta">Host: ' + esc(host) + '</div>' +
            '<div class="agent-meta">Last seen: ' + lastSeen + '</div>' +
            queueDepth +
            '</div>';
        }).join('');
      } catch (e) { console.error('Agent load error:', e); }
    }

    // === Section 2: Work Queue ===
    let queueItems = [];
    let currentFilter = 'all';
    const STATUS_ORDER = { 'in-progress': 0, blocked: 1, pending: 2, deferred: 3, idea: 4, completed: 5 };
    const PILL_CLASS = { pending: 'pill-pending', 'in-progress': 'pill-in-progress', blocked: 'pill-blocked', deferred: 'pill-deferred', completed: 'pill-completed', idea: 'pill-idea' };
    const PILL_LABEL = { pending: 'Pending', 'in-progress': 'In Progress', blocked: 'Blocked', deferred: 'Deferred', completed: 'Completed', idea: 'Idea' };

    async function loadQueue() {
      try {
        const data = await fetch('/api/queue').then(r => r.json());
        queueItems = data.items || [];
        renderQueueFilters();
        renderQueue();
      } catch (e) { console.error('Queue load error:', e); }
    }

    function renderQueueFilters() {
      const counts = { all: queueItems.length };
      for (const item of queueItems) counts[item.status] = (counts[item.status] || 0) + 1;
      const filters = [['all','All'],['pending','Pending'],['in-progress','In Progress'],['blocked','Blocked'],['deferred','Deferred'],['completed','Completed'],['idea','Ideas']];
      document.getElementById('queue-filters').innerHTML = filters.map(([val, label]) => {
        const c = counts[val] || 0;
        const active = currentFilter === val ? ' active' : '';
        return '<button class="filter-btn' + active + '" data-filter="' + val + '" onclick="setQueueFilter(\\'' + val + '\\')">' + label + ' (' + c + ')</button>';
      }).join('');
    }

    function setQueueFilter(f) {
      currentFilter = f;
      renderQueueFilters();
      renderQueue();
    }

    function renderQueue() {
      const sorted = [...queueItems].sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99));
      const filtered = currentFilter === 'all' ? sorted : sorted.filter(i => i.status === currentFilter);
      if (filtered.length === 0) {
        document.getElementById('queue-body').innerHTML = '<tr><td colspan="5" style="padding:16px;color:#8b949e">No items</td></tr>';
        return;
      }
      document.getElementById('queue-body').innerHTML = filtered.map(item => {
        const pill = '<span class="pill ' + (PILL_CLASS[item.status] || 'pill-deferred') + '">' + (PILL_LABEL[item.status] || item.status) + '</span>';
        let actions = '';
        if (item.status === 'idea') {
          actions += '<button class="action-btn promote" onclick="queueAction(\\'/api/upvote/' + item.id + '\\',\\'POST\\')">⬆️ Promote</button>';
        }
        if (item.status === 'blocked') {
          actions += '<input class="cmt-input" id="cmt-' + item.id + '" placeholder="Comment...">' +
            '<button class="action-btn comment" onclick="sendComment(\\'' + item.id + '\\')" >💬</button>';
        }
        if (item.status !== 'completed' && item.status !== 'idea') {
          actions += '<button class="action-btn complete" onclick="queueAction(\\'/api/complete/' + item.id + '\\',\\'POST\\')">✓</button>';
        }
        const priority = item.priority || '—';
        return '<tr>' +
          '<td>' + pill + '</td>' +
          '<td><div style="font-weight:600;font-size:13px">' + esc(item.title) + '</div><div style="color:#8b949e;font-size:12px;margin-top:1px">' + esc((item.description || '').slice(0, 120)) + '</div></td>' +
          '<td style="color:#8b949e;font-size:12px">' + esc(item.assignee || '—') + '</td>' +
          '<td style="color:#8b949e;font-size:12px">' + esc(String(priority)) + '</td>' +
          '<td style="white-space:nowrap">' + actions + '</td>' +
          '</tr>';
      }).join('');
    }

    async function queueAction(url, method, body) {
      const token = getToken();
      if (!token) return showToast('No token', true);
      try {
        const opts = { method, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const resp = await fetch(url, opts);
        const data = await resp.json();
        if (data.ok) { showToast('Done!'); loadQueue(); }
        else showToast(data.error || 'Error', true);
      } catch (e) { showToast(e.message, true); }
    }

    function sendComment(id) {
      const input = document.getElementById('cmt-' + id);
      const text = input ? input.value.trim() : '';
      if (!text) return showToast('Enter a comment first', true);
      queueAction('/api/comment/' + id, 'POST', { text });
    }

    // === Section 3: QuestBus ===
    let busMessages = [];
    let busFilter = 'all';
    let lastBusTs = null;

    async function loadBus(initial) {
      try {
        const url = initial ? '/bus/messages?limit=50' : '/bus/messages?limit=50' + (lastBusTs ? '&since=' + encodeURIComponent(lastBusTs) : '');
        const msgs = await fetch(url).then(r => r.json());
        if (initial) {
          busMessages = msgs;
        } else if (msgs.length > 0) {
          // Prepend new messages (they come newest-first)
          const existingIds = new Set(busMessages.map(m => m.id));
          const newMsgs = msgs.filter(m => !existingIds.has(m.id));
          if (newMsgs.length > 0) busMessages = [...newMsgs, ...busMessages];
        }
        if (busMessages.length > 0 && busMessages[0].ts) lastBusTs = busMessages[0].ts;
        renderBusFilters();
        renderBus();
      } catch (e) { console.error('Bus load error:', e); }
    }

    function renderBusFilters() {
      const agents = ['all', 'drquest', 'race', 'hadji', 'jkh'];
      document.getElementById('bus-filters').innerHTML = agents.map(agent => {
        const emoji = agent === 'all' ? '📡' : (EMOJIS[agent] || '📨');
        const active = busFilter === agent ? ' active' : '';
        return '<button class="bus-filter-btn' + active + '" onclick="setBusFilter(\\'' + agent + '\\')">' + emoji + ' ' + agent.charAt(0).toUpperCase() + agent.slice(1) + '</button>';
      }).join('');
    }

    function setBusFilter(f) {
      busFilter = f;
      renderBusFilters();
      renderBus();
    }

    function renderBus() {
      const filtered = busFilter === 'all' ? busMessages : busMessages.filter(m => m.from === busFilter || m.to === busFilter);
      if (filtered.length === 0) {
        document.getElementById('bus-messages').innerHTML = '<div style="color:#8b949e;padding:12px">No messages</div>';
        return;
      }
      document.getElementById('bus-messages').innerHTML = filtered.map(renderBusMsg).join('');
    }

    function renderBusMsg(msg) {
      const fromEmoji = EMOJIS[msg.from] || '📨';
      const toLabel = msg.to === 'all' ? 'all' : msg.to;
      const ts = new Date(msg.ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const typeColor = TYPE_COLORS[msg.type] || '#8b949e';

      // Compact rendering for heartbeat/ping/pong
      if (msg.type === 'heartbeat' || msg.type === 'ping' || msg.type === 'pong') {
        const icon = msg.type === 'heartbeat' ? '💓' : '🏓';
        return '<div class="bus-msg compact" data-from="' + esc(msg.from) + '">' +
          fromEmoji + ' ' + esc(msg.from) + ' ' + icon + ' ' + msg.type + ' · #' + msg.seq + ' · ' + esc(ts) +
          '</div>';
      }

      let subject = msg.subject ? '<div style="font-weight:600;color:#58a6ff;margin-bottom:3px;font-size:13px">' + esc(msg.subject) + '</div>' : '';
      let bodyHtml = '';

      switch (msg.type) {
        case 'text':
        case 'memo':
          bodyHtml = '<div style="white-space:pre-wrap;font-size:13px">' + esc(msg.body) + '</div>';
          break;
        case 'blob':
          if (msg.mime && msg.mime.startsWith('image/')) {
            const src = msg.enc === 'base64' ? 'data:' + msg.mime + ';base64,' + msg.body : esc(msg.body);
            bodyHtml = '<img src="' + src + '" style="max-width:360px;border-radius:6px;margin-top:4px">';
          } else if (msg.mime && msg.mime.startsWith('audio/')) {
            const src = msg.enc === 'base64' ? 'data:' + msg.mime + ';base64,' + msg.body : esc(msg.body);
            bodyHtml = '<audio controls src="' + src + '" style="margin-top:4px"></audio>';
          } else if (msg.mime && msg.mime.startsWith('video/')) {
            const src = msg.enc === 'base64' ? 'data:' + msg.mime + ';base64,' + msg.body : esc(msg.body);
            bodyHtml = '<video controls src="' + src + '" style="max-width:360px;border-radius:6px;margin-top:4px"></video>';
          } else {
            bodyHtml = '<pre style="background:#0d1117;padding:6px;border-radius:4px;overflow-x:auto;font-size:11px">' + esc((msg.body || '').slice(0, 500)) + '</pre>';
          }
          break;
        case 'queue_sync':
          bodyHtml = '<details style="margin-top:4px"><summary style="cursor:pointer;color:#58a6ff;font-size:12px">Queue sync data</summary><pre style="background:#0d1117;padding:6px;border-radius:4px;overflow-x:auto;font-size:11px;margin-top:4px">' + esc(typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body, null, 2)) + '</pre></details>';
          break;
        default:
          bodyHtml = '<pre style="background:#0d1117;padding:6px;border-radius:4px;overflow-x:auto;font-size:11px">' + esc(JSON.stringify(msg, null, 2)) + '</pre>';
      }

      return '<div class="bus-msg" data-from="' + esc(msg.from) + '">' +
        '<div class="bus-header">' +
          '<div>' + fromEmoji + ' <strong style="color:#f0f6fc">' + esc(msg.from) + '</strong>' +
          ' <span style="color:#484f58">→</span> <strong>' + esc(toLabel) + '</strong>' +
          ' <span class="type-badge" style="background:' + typeColor + '">' + esc(msg.type) + '</span></div>' +
          '<div style="color:#484f58;font-size:11px">#' + msg.seq + ' · ' + esc(ts) + '</div>' +
        '</div>' +
        subject + bodyHtml +
        '</div>';
    }

    // === Send bus message ===
    async function sendBusMessage() {
      const token = getToken();
      if (!token) return showToast('No token', true);
      const body = {
        from: document.getElementById('msg-from').value,
        to: document.getElementById('msg-to').value,
        type: document.getElementById('msg-type').value,
        subject: document.getElementById('msg-subject').value || null,
        body: document.getElementById('msg-body').value,
      };
      if (!body.body && body.type !== 'ping') return showToast('Body required', true);
      try {
        const resp = await fetch('/bus/send', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (data.ok) {
          showToast('Message sent!');
          document.getElementById('msg-body').value = '';
          document.getElementById('msg-subject').value = '';
          loadBus(true);
        } else showToast(data.error || 'Error', true);
      } catch (e) { showToast(e.message, true); }
    }

    // === Init & refresh ===
    loadAgents();
    loadQueue();
    loadBus(true);

    // Auto-refresh agent cards every 30s
    setInterval(loadAgents, 30000);
    // Auto-refresh queue every 60s
    setInterval(loadQueue, 60000);
    // Auto-refresh bus every 10s (incremental)
    setInterval(() => loadBus(false), 10000);

    document.getElementById('footer').textContent = '🐿️ Dr. Quest Command Center · Auto-refreshing · Rendered: ' + new Date().toLocaleString();
  </script>
</body>
</html>`;
}

// --- Metrics API ---

app.get('/api/metrics', async (req, res) => {
  try {
    const data = await readQueue();
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000; // 24h

    // All items (active + completed array)
    const allItems = [...(data.items || []), ...(data.completed || [])];

    // items_completed_24h
    const completed24h = allItems.filter(i =>
      i.status === 'completed' && i.completedAt &&
      (now - new Date(i.completedAt).getTime()) < windowMs
    );

    // avg_time_to_completion_h (for items with both createdAt and completedAt)
    const timings = completed24h
      .filter(i => i.created && i.completedAt)
      .map(i => (new Date(i.completedAt).getTime() - new Date(i.created).getTime()) / 3600000);
    const avg_ttc = timings.length > 0
      ? parseFloat((timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(2))
      : null;

    // blocked_count
    const blocked = (data.items || []).filter(i => i.status === 'blocked');

    // pending_by_assignee
    const pending = (data.items || []).filter(i => i.status === 'pending');
    const pendingByAssignee = {};
    for (const item of pending) {
      const a = item.assignee || 'unassigned';
      pendingByAssignee[a] = (pendingByAssignee[a] || 0) + 1;
    }

    // in_progress_by_assignee
    const inProgress = (data.items || []).filter(i => i.status === 'in_progress' || i.status === 'in-progress');
    const inProgressByAssignee = {};
    for (const item of inProgress) {
      const a = item.assignee || 'unassigned';
      inProgressByAssignee[a] = (inProgressByAssignee[a] || 0) + 1;
    }

    // total_active (pending + in_progress + blocked)
    const totalActive = pending.length + inProgress.length + blocked.length;

    // idea backlog count
    const ideas = (data.items || []).filter(i => i.status === 'pending' && i.priority === 'idea');

    res.json({
      ts: new Date().toISOString(),
      items_completed_24h: completed24h.length,
      avg_time_to_completion_h: avg_ttc,
      blocked_count: blocked.length,
      total_active: totalActive,
      pending_count: pending.length,
      in_progress_count: inProgress.length,
      idea_backlog: ideas.length,
      pending_by_assignee: pendingByAssignee,
      in_progress_by_assignee: inProgressByAssignee,
      last_completed: completed24h.length > 0
        ? completed24h.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0]
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Changelog API ---
// GET /api/changelog?id=<itemId>&limit=30
// Returns reconstructed status-change history for a queue item, newest first.
// History is assembled from: (a) notes field lines containing bracketed events,
// (b) key timestamp fields (created, claimedAt, completedAt), (c) itemVersion bumps.
app.get('/api/changelog', async (req, res) => {
  try {
    const itemId = (req.query.id || '').trim();
    if (!itemId) return res.status(400).json({ error: 'id query param required' });
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);

    const data = await readQueue();
    const allItems = [...(data.items || []), ...(data.completed || [])];
    const item = allItems.find(i => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'item not found', id: itemId });

    const events = [];

    // 1. Parse bracketed/timestamped events from notes field
    // Supports patterns like:
    //   "[promoted] idea→normal via quorum 2026-03-21T04:08Z"
    //   "jkh comment [2026-03-21T04:08:00.000Z]: text"
    //   "[escalated] normal→high at 2026-03-21T04:08:00.000Z"
    //   "Unblocked by completion of X at 2026-03-21T04:08:00.000Z"
    if (item.notes) {
      const noteLines = item.notes.split('\n').filter(l => l.trim());
      for (const line of noteLines) {
        // Extract ISO timestamp from line if present
        const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)/);
        const ts = isoMatch ? new Date(isoMatch[1]).toISOString() : null;

        // Classify event type from content
        let type = 'note';
        const lower = line.toLowerCase();
        if (/\[promoted\]|promoted to task/.test(lower))     type = 'promotion';
        else if (/\[escalated\]/.test(lower))                type = 'escalation';
        else if (/unblocked/.test(lower))                    type = 'unblocked';
        else if (/claimed by|claimedby/.test(lower))         type = 'claim';
        else if (/jkh comment/.test(lower))                  type = 'comment';
        else if (/completed by|marked complete/.test(lower)) type = 'completion';
        else if (/assigned to/.test(lower))                  type = 'assignment';
        else if (/proposed/.test(lower))                     type = 'proposed';

        events.push({ ts, type, detail: line.trim(), source: 'notes' });
      }
    }

    // 2. Synthetic events from structured timestamp fields
    if (item.created) {
      events.push({ ts: item.created, type: 'created', detail: `Item created (source: ${item.source || 'unknown'})`, source: 'field' });
    }
    if (item.claimedAt && item.claimedBy) {
      events.push({ ts: item.claimedAt, type: 'claim', detail: `Claimed by ${item.claimedBy}`, source: 'field' });
    }
    if (item.lastAttempt) {
      events.push({ ts: item.lastAttempt, type: 'attempt', detail: `Last attempt recorded`, source: 'field' });
    }
    if (item.completedAt) {
      events.push({ ts: item.completedAt, type: 'completed', detail: `Completed (status: ${item.status})`, source: 'field' });
    }

    // 3. Current state snapshot
    events.push({
      ts: null,
      type: 'current_state',
      detail: `status=${item.status} assignee=${item.assignee || '—'} priority=${item.priority} itemVersion=${item.itemVersion || 1}`,
      source: 'snapshot',
    });

    // Sort: timestamped entries newest-first, null-ts (current_state) at top
    events.sort((a, b) => {
      if (!a.ts && !b.ts) return 0;
      if (!a.ts) return -1;
      if (!b.ts) return 1;
      return new Date(b.ts) - new Date(a.ts);
    });

    // Deduplicate by (ts, detail) — notes and field events can overlap
    const seen = new Set();
    const deduped = events.filter(e => {
      const key = `${e.ts}|${e.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({
      id: itemId,
      title: item.title || itemId,
      itemVersion: item.itemVersion || 1,
      totalEvents: deduped.length,
      changelog: deduped.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Dashboard route ---
app.get('/', (req, res) => {
  res.type('html').send(renderUnifiedPage());
});

// Redirect /bus to /
app.get('/bus', (req, res) => {
  // Check if this is an API-like request or browser request
  if (req.path === '/bus' && !req.path.startsWith('/bus/')) {
    return res.redirect('/');
  }
  res.redirect('/');
});

// ========================================
// QuestBus v1 — Inter-agent comms
// ========================================

let busSeq = 0;
const busSSEClients = new Set();
const busPresence = {};

async function initBusSeq() {
  try {
    if (!existsSync(BUS_LOG_PATH)) return;
    const rl = createInterface({ input: createRS(BUS_LOG_PATH), crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const msg = JSON.parse(line);
        if (msg.seq && msg.seq > busSeq) busSeq = msg.seq;
      } catch {}
    }
    console.log(`📡 QuestBus: initialized seq=${busSeq}`);
  } catch (e) {
    console.error('Bus seq init error:', e.message);
  }
}

async function readBusMessages({ from, to, limit = 100, since, type } = {}) {
  const messages = [];
  try {
    if (!existsSync(BUS_LOG_PATH)) return messages;
    const rl = createInterface({ input: createRS(BUS_LOG_PATH), crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const msg = JSON.parse(line);
        if (from && msg.from !== from) continue;
        if (to && msg.to !== to && msg.to !== 'all') continue;
        if (type && msg.type !== type) continue;
        if (since && new Date(msg.ts) <= new Date(since)) continue;
        messages.push(msg);
      } catch {}
    }
  } catch {}
  return messages.slice(-limit).reverse();
}

async function appendBusMessage(msg) {
  const full = {
    id: msg.id || randomUUID(),
    from: msg.from || 'unknown',
    to: msg.to || 'all',
    ts: msg.ts || new Date().toISOString(),
    seq: ++busSeq,
    type: msg.type || 'text',
    mime: msg.mime || 'text/plain',
    enc: msg.enc || 'none',
    body: msg.body || '',
    ref: msg.ref || null,
    subject: msg.subject || null,
    ttl: msg.ttl ?? 604800,
  };
  const line = JSON.stringify(full) + '\n';
  await appendFile(BUS_LOG_PATH, line, 'utf8');

  try {
    execFile(MC_PATH, ['cp', BUS_LOG_PATH, `${MINIO_ALIAS}/agents/shared/questbus.jsonl`], { timeout: 10000 }, (err) => {
      if (err) console.error('MinIO bus upload error:', err.message);
    });
  } catch {}

  for (const client of busSSEClients) {
    try {
      client.write(`data: ${JSON.stringify(full)}\n\n`);
    } catch { busSSEClients.delete(client); }
  }

  // Fire-and-forget fan-out to registered peer endpoints
  fanOutBusMessage(full);

  return full;
}

// CORS for bus endpoints
app.use('/bus', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/bus/send', requireAuth, async (req, res) => {
  try {
    const msg = await appendBusMessage(req.body);
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/bus/messages', async (req, res) => {
  try {
    const { from, to, limit, since, type } = req.query;
    const messages = await readBusMessages({
      from, to, type, since,
      limit: limit ? parseInt(limit, 10) : 100,
    });
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/bus/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');
  busSSEClients.add(res);
  req.on('close', () => busSSEClients.delete(res));
});

app.post('/bus/heartbeat', requireAuth, async (req, res) => {
  try {
    const { from } = req.body;
    if (!from) return res.status(400).json({ error: 'Missing "from" field' });
    busPresence[from] = {
      agent: from,
      ts: new Date().toISOString(),
      status: 'online',
      ...req.body,
    };
    await appendBusMessage({
      from,
      to: 'all',
      type: 'heartbeat',
      body: JSON.stringify({ status: 'online', ...req.body }),
      mime: 'application/json',
    });
    res.json({ ok: true, presence: busPresence });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/bus/presence', (req, res) => {
  res.json(busPresence);
});

// Initialize bus sequence on startup
initBusSeq();

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐿️ Dr. Quest Command Center running on http://0.0.0.0:${PORT}`);
});
