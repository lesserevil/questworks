#!/usr/bin/env node
/**
 * bandit-watchdog.mjs
 *
 * Mattermost watchdog for the QuestWorks team.
 * Designed to run via cron (not as a daemon) — exits cleanly after each run.
 *
 * Checks (every run):
 *   1. Stale claims  — clears pending claims >15 min old
 *   2. Escalation    — promotes stale items up the priority ladder
 *   3. Activity      — barks at assignees quiet for 30+ min on in_progress tasks
 *   4. Daily summary — posts team status to town-square (once per calendar day)
 *
 * Usage:
 *   node bandit-watchdog.mjs [--queue path/to/queue.json] [--channel-map path/to/channel-map.json]
 *
 * Env:
 *   MM_BASE_URL   — Mattermost base URL, e.g. https://quest.mass-hysteria.org
 *   MM_BOT_TOKEN  — bot auth token
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKQUEUE_DIR = resolve(__dirname, '..');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cliArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const QUEUE_PATH       = cliArg('--queue')       || resolve(WORKQUEUE_DIR, 'queue.json');
const CHANNEL_MAP_PATH = cliArg('--channel-map') || resolve(__dirname, 'channel-map.json');
const STATE_PATH       = resolve(__dirname, '.bandit-state.json');
const ALERTS_PATH      = resolve(WORKQUEUE_DIR, 'alerts.jsonl');

// ── Env ───────────────────────────────────────────────────────────────────────

const MM_BASE_URL  = (process.env.MM_BASE_URL  || '').replace(/\/$/, '');
const MM_BOT_TOKEN =  process.env.MM_BOT_TOKEN || '';

// ── Thresholds ────────────────────────────────────────────────────────────────

const QUIET_THRESHOLD_MS = 30 * 60 * 1000;   // 30 min — bark if assignee silent longer
const STALE_CLAIM_MS     = 15 * 60 * 1000;   // 15 min — clear stale pending claims

// Priority escalation rules (never auto-escalate to urgent)
const ESCALATION_RULES = [
  { from: 'idea',   to: 'low',    maxAgeMs: 72 * 60 * 60 * 1000 },
  { from: 'low',    to: 'normal', maxAgeMs: 48 * 60 * 60 * 1000 },
  { from: 'normal', to: 'high',   maxAgeMs: 24 * 60 * 60 * 1000 },
];

// ── Logging ───────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString();
const log  = (msg) => console.log( `[bandit ${ts()}] ${msg}`);
const warn = (msg) => console.warn(`[bandit ${ts()}] WARN: ${msg}`);

// ── File I/O ──────────────────────────────────────────────────────────────────

function loadQueue() {
  return JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
}

function saveQueue(queue) {
  queue.lastSync = new Date().toISOString();
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n', 'utf8');
}

function loadChannelMap() {
  return JSON.parse(readFileSync(CHANNEL_MAP_PATH, 'utf8'));
}

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function appendAlert(entry) {
  appendFileSync(ALERTS_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

// ── Mattermost API ────────────────────────────────────────────────────────────

async function mmGet(path) {
  const res = await fetch(`${MM_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${MM_BOT_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MM GET ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function mmPost(channelId, message) {
  const res = await fetch(`${MM_BASE_URL}/api/v4/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MM_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel_id: channelId, message }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MM POST /api/v4/posts → ${res.status}: ${body}`);
  }
  return res.json();
}

// username → user_id cache (avoid redundant lookups per run)
const userIdCache = {};

async function resolveUserId(username) {
  if (userIdCache[username]) return userIdCache[username];
  try {
    const user = await mmGet(`/api/v4/users/username/${username}`);
    userIdCache[username] = user.id;
    return user.id;
  } catch (e) {
    warn(`Could not resolve user ID for "${username}": ${e.message}`);
    return null;
  }
}

async function getChannelPosts(channelId, perPage = 10) {
  const data = await mmGet(`/api/v4/channels/${channelId}/posts?per_page=${perPage}`);
  // data.order = post IDs newest-first; data.posts = id → post map
  return (data.order || []).map(id => data.posts[id]);
}

// ── Check 1: Stale Claims ─────────────────────────────────────────────────────

function checkStaleClaims(queue) {
  const now = Date.now();
  let changed = false;

  for (const item of (queue.items || [])) {
    if (item.status !== 'pending') continue;
    if (!item.claimedBy || !item.claimedAt) continue;

    const ageMs = now - new Date(item.claimedAt).getTime();
    if (ageMs <= STALE_CLAIM_MS) continue;

    const ageMin = Math.round(ageMs / 60000);
    log(`Stale claim: clearing ${item.id} (claimed by ${item.claimedBy}, ${ageMin}m ago)`);
    item.claimedBy   = null;
    item.claimedAt   = null;
    item.itemVersion = (item.itemVersion || 1) + 1;
    changed = true;
  }

  if (!changed) log('Stale claims: none found.');
  return changed;
}

// ── Check 2: Priority Escalation ─────────────────────────────────────────────

function checkEscalation(queue) {
  const now = Date.now();
  let changed = false;

  for (const item of (queue.items || [])) {
    if (item.status !== 'pending') continue;

    const rule = ESCALATION_RULES.find(r => r.from === item.priority);
    if (!rule) continue;

    const ageMs = now - new Date(item.created).getTime();
    if (ageMs < rule.maxAgeMs) continue;

    const oldPriority = item.priority;
    const ageHours = Math.round(ageMs / 3_600_000);

    item.priority    = rule.to;
    item.itemVersion = (item.itemVersion || 1) + 1;
    changed = true;

    const alert = {
      ts:        new Date().toISOString(),
      type:      'priority_escalation',
      id:        item.id,
      title:     item.title,
      from:      oldPriority,
      to:        rule.to,
      ageHours,
      assignee:  item.assignee,
    };
    appendAlert(alert);
    log(`Escalated ${item.id}: ${oldPriority} → ${rule.to} (age ${ageHours}h) — "${item.title}"`);
  }

  if (!changed) log('Priority escalation: no items to escalate.');
  return changed;
}

// ── Check 3: Activity ─────────────────────────────────────────────────────────

async function checkActivity(queue, channelMap) {
  const inProgress = (queue.items || []).filter(i => i.status === 'in_progress');

  if (inProgress.length === 0) {
    log('Activity check: no in_progress items.');
    return;
  }

  log(`Activity check: ${inProgress.length} in_progress item(s).`);
  const now = Date.now();

  for (const item of inProgress) {
    const assignee = item.assignee;

    // Skip unassigned / team-wide items — no single person to bark at
    if (!assignee || assignee === 'all') continue;

    const channelId = channelMap[assignee];
    if (!channelId || channelId.startsWith('CHANNEL_ID_')) {
      warn(`Activity check: no channel mapping for assignee "${assignee}" — skipping ${item.id}`);
      continue;
    }

    // Fetch recent posts
    let posts;
    try {
      posts = await getChannelPosts(channelId, 10);
    } catch (e) {
      warn(`Activity check: could not fetch posts for ${assignee} (channel ${channelId}): ${e.message}`);
      continue;
    }

    // Resolve assignee's Mattermost user ID so we can match posts
    const userId = await resolveUserId(assignee);

    // Find the most recent post made by the assignee
    let lastPostAt = null;
    for (const post of posts) {
      if (userId && post.user_id === userId) {
        if (lastPostAt === null || post.create_at > lastPostAt) {
          lastPostAt = post.create_at; // milliseconds epoch
        }
      }
    }

    const silentMs = lastPostAt !== null ? now - lastPostAt : null;
    const isQuiet  = silentMs === null || silentMs >= QUIET_THRESHOLD_MS;

    if (!isQuiet) {
      log(`Activity OK: ${assignee} posted ${Math.floor(silentMs / 60000)}m ago on ${item.id}`);
      continue;
    }

    // Compute best estimate of silent minutes for the bark message
    let minutesSilent;
    if (silentMs !== null) {
      minutesSilent = Math.floor(silentMs / 60000);
    } else {
      // No posts from this user in the last 10 — estimate from task timestamps
      const taskStart = item.lastAttempt || item.claimedAt;
      minutesSilent = taskStart
        ? Math.floor((now - new Date(taskStart).getTime()) / 60000)
        : 30; // conservative floor — we know it's at least the threshold
    }

    const bark = `🐕 WOOF! @${assignee} — you have been quiet for ${minutesSilent} min on ${item.id}: ${item.title}. Post an update!`;
    log(`Barking at ${assignee} in channel ${channelId} (${item.id}, ${minutesSilent}m silent)`);
    try {
      await mmPost(channelId, bark);
    } catch (e) {
      warn(`Activity check: failed to post bark for ${assignee}: ${e.message}`);
    }
  }
}

// ── Check 4: Daily Summary ────────────────────────────────────────────────────

async function checkDailySummary(queue, channelMap, state) {
  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  if (state.lastDailySummaryDate === today) {
    log('Daily summary: already posted today, skipping.');
    return false;
  }

  const townSquareId = channelMap['town-square'];
  if (!townSquareId || townSquareId.startsWith('CHANNEL_ID_')) {
    warn('Daily summary: town-square channel ID not configured — skipping.');
    return false;
  }

  const items     = queue.items     || [];
  const completed = queue.completed || [];

  // Group active items by assignee
  const byAssignee = {};
  for (const item of items) {
    const a = item.assignee || 'unknown';
    if (!byAssignee[a]) byAssignee[a] = { in_progress: [], pending: [], blocked: [] };
    if      (item.status === 'in_progress') byAssignee[a].in_progress.push(item);
    else if (item.status === 'pending')     byAssignee[a].pending.push(item);
    else if (item.status === 'blocked')     byAssignee[a].blocked.push(item);
  }

  // Completed yesterday
  const doneYesterday = completed.filter(
    i => i.completedAt && i.completedAt.slice(0, 10) === yesterday
  );

  // Hot queue
  const urgentCount = items.filter(i => i.priority === 'urgent').length;
  const highCount   = items.filter(i => i.priority === 'high').length;
  const blockedAll  = items.filter(i => i.status === 'blocked');

  const lines = [`**🐕 Bandit's Daily Briefing** — ${today}`, ''];

  // Per-agent active work (skip "all" here — it's a pool, not a person)
  const agents = Object.keys(byAssignee).filter(a => a !== 'all').sort();
  if (agents.length > 0) {
    lines.push('**Active work:**');
    for (const agent of agents) {
      const { in_progress, pending, blocked } = byAssignee[agent];
      const parts = [];
      if (in_progress.length) parts.push(`${in_progress.length} in-progress`);
      if (pending.length)     parts.push(`${pending.length} pending`);
      if (blocked.length)     parts.push(`${blocked.length} blocked`);
      if (parts.length)       lines.push(`• @${agent}: ${parts.join(', ')}`);
    }
  } else {
    lines.push('• No individually-assigned work in flight.');
  }

  // Unassigned pool
  const pool = byAssignee['all'];
  if (pool) {
    const unassigned = (pool.pending || []).length + (pool.in_progress || []).length;
    if (unassigned) {
      lines.push('');
      lines.push(`**Unassigned pool:** ${unassigned} item(s) available for anyone`);
    }
  }

  // Blocked items
  if (blockedAll.length > 0) {
    lines.push('');
    lines.push('**Blocked:**');
    for (const item of blockedAll) {
      lines.push(`• ${item.id}: ${item.title} [@${item.assignee}]`);
    }
  }

  // Completed yesterday
  lines.push('');
  if (doneYesterday.length > 0) {
    lines.push(`**Completed yesterday (${yesterday}):**`);
    for (const item of doneYesterday) {
      lines.push(`• ✅ ${item.id}: ${item.title} [@${item.assignee}]`);
    }
  } else {
    lines.push(`**Completed yesterday:** nothing`);
  }

  // Hot queue callout
  if (urgentCount || highCount) {
    lines.push('');
    lines.push(`**Hot queue:** ${urgentCount} urgent 🔴, ${highCount} high 🟠 — eyes on it!`);
  }

  log(`Posting daily summary to town-square (${townSquareId})`);
  await mmPost(townSquareId, lines.join('\n'));
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!MM_BASE_URL)  { console.error('[bandit] MM_BASE_URL is not set');  process.exit(1); }
  if (!MM_BOT_TOKEN) { console.error('[bandit] MM_BOT_TOKEN is not set'); process.exit(1); }

  log(`Bandit watchdog starting. Queue: ${QUEUE_PATH}`);

  let channelMap;
  try {
    channelMap = loadChannelMap();
  } catch (e) {
    console.error(`[bandit] Failed to load channel map from ${CHANNEL_MAP_PATH}: ${e.message}`);
    process.exit(1);
  }

  let queue;
  try {
    queue = loadQueue();
  } catch (e) {
    console.error(`[bandit] Failed to load queue from ${QUEUE_PATH}: ${e.message}`);
    process.exit(1);
  }

  const state = loadState();
  let queueDirty = false;

  // ── 1. Stale claims ───────────────────────────────────────────────────────
  log('--- [1/4] Stale claim check ---');
  if (checkStaleClaims(queue)) queueDirty = true;

  // ── 2. Priority escalation ────────────────────────────────────────────────
  log('--- [2/4] Priority escalation ---');
  if (checkEscalation(queue)) queueDirty = true;

  // ── 3. Activity check ─────────────────────────────────────────────────────
  log('--- [3/4] Activity check ---');
  await checkActivity(queue, channelMap);

  // ── 4. Daily summary ──────────────────────────────────────────────────────
  log('--- [4/4] Daily summary ---');
  try {
    const posted = await checkDailySummary(queue, channelMap, state);
    if (posted) {
      state.lastDailySummaryDate = new Date().toISOString().slice(0, 10);
      saveState(state);
      log('Daily summary posted and state saved.');
    }
  } catch (e) {
    warn(`Daily summary failed: ${e.message}`);
  }

  // ── Persist queue changes ─────────────────────────────────────────────────
  if (queueDirty) {
    saveQueue(queue);
    log('Queue saved with changes.');
  } else {
    log('Queue unchanged.');
  }

  log('Bandit watchdog done.');
}

main().catch(e => {
  console.error('[bandit] Fatal error:', e);
  process.exit(1);
});
