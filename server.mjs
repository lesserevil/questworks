import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';

import { getDb } from './db/index.mjs';
import { loadAdapterConfigs } from './db/adapters.mjs';
import { getConfig } from './db/config.mjs';
import { GitHubAdapter } from './adapters/github.mjs';
import { JiraAdapter } from './adapters/jira.mjs';
import { BeadsAdapter } from './adapters/beads.mjs';
import { SyncScheduler } from './sync/scheduler.mjs';
import { SlackNotifier } from './slack/notify.mjs';
import { createSlashRouter, handleConversationReply } from './slack/slash.mjs';
import { createEventsRouter } from './slack/events.mjs';
import { startSocketMode } from './slack/socket.mjs';
import { ManualAdapter } from './adapters/manual.mjs';
import { createTaskRoutes } from './routes/tasks.mjs';
import { createAdapterRoutes } from './routes/adapters.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADAPTER_TYPES = { github: GitHubAdapter, jira: JiraAdapter, beads: BeadsAdapter, manual: ManualAdapter };

// --- Config ---
function loadConfig() {
  const configPath = process.env.QUESTWORKS_CONFIG || join(__dirname, 'config.yaml');
  if (!existsSync(configPath)) {
    console.warn(`[config] No config.yaml found at ${configPath}, using defaults`);
    return { adapters: [], slack: {}, sync: { interval_seconds: 60 }, server: { port: 8788 } };
  }
  const raw = readFileSync(configPath, 'utf8');
  const expanded = raw.replace(/\$(\w+)/g, (_, name) => process.env[name] || '');
  return yaml.load(expanded);
}

function buildAdapters(adapterConfigs) {
  const map = new Map();
  for (const ac of (adapterConfigs || [])) {
    const Cls = ADAPTER_TYPES[ac.type];
    if (!Cls) { console.warn(`[config] Unknown adapter type: ${ac.type}`); continue; }
    map.set(ac.id, new Cls(ac.id, ac.config || {}));
    console.log(`[adapters] Registered ${ac.type} adapter from config.yaml: ${ac.id}`);
  }
  return map;
}

async function loadDbAdapters(db, adapters) {
  const rows = await loadAdapterConfigs(db);
  for (const row of rows) {
    try {
      const config = decryptJson(row.config_encrypted);
      const Cls = ADAPTER_TYPES[row.type];
      if (!Cls) { console.warn(`[adapters] Unknown type in DB: ${row.type}`); continue; }
      adapters.set(row.id, new Cls(row.id, config));
      console.log(`[adapters] Loaded ${row.type} adapter from DB: ${row.id}`);
    } catch (err) {
      console.warn(`[adapters] Failed to load DB adapter ${row.id}:`, err.message);
    }
  }
}

// --- Main ---
async function main() {
  const config = loadConfig();

  // Initialize DB — backend selected via DATABASE_URL
  const db = await getDb();
  const dbLabel = db.backend === 'postgres' ? 'postgres' : (db.dbPath || 'sqlite');

  // Build adapter registry: config.yaml first, then DB (DB overrides yaml for same ID)
  const adapters = buildAdapters(config.adapters);
  await loadDbAdapters(db, adapters);

  const slackConfig = config.slack || {};
  const slackToken = process.env.SLACK_TOKEN || slackConfig.token || '';
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET || slackConfig.signing_secret || '';
  const slackAppToken = process.env.SLACK_APP_TOKEN || slackConfig.app_token || '';

  const notifier = new SlackNotifier({ token: slackToken, channel: slackConfig.channel });
  const syncInterval = config.sync?.interval_seconds || 60;
  const scheduler = new SyncScheduler(db, adapters, notifier, syncInterval);

  const slackOpts = { token: slackToken, signingSecret: slackSigningSecret };

  // Socket Mode — if SLACK_APP_TOKEN is set, use WebSocket instead of HTTP endpoints
  if (slackAppToken) {
    await startSocketMode(db, adapters, scheduler, { token: slackToken, appToken: slackAppToken });
    console.log('[questworks] Slack Socket Mode active (no public URL needed)');
  }

  const app = express();

  // Mount Slack HTTP routes BEFORE global express.json() so their own body parsers
  // can capture the raw body needed for request signature verification.
  // These are used when Socket Mode is NOT active (no SLACK_APP_TOKEN).
  app.use('/slash', createSlashRouter(db, adapters, scheduler, slackOpts));
  app.use('/slack', createEventsRouter(db, handleConversationReply, slackOpts));

  app.use(express.json());

  // Auth middleware (optional — skip if no token configured)
  const AUTH_TOKEN = process.env.QUESTWORKS_TOKEN || config.server?.auth_token;
  app.use((req, res, next) => {
    if (!AUTH_TOKEN) return next();
    if (req.path === '/health' || req.path === '/' || req.path.startsWith('/slash') || req.path.startsWith('/slack/')) return next();
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${AUTH_TOKEN}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  // Routes
  app.use('/tasks', createTaskRoutes(db, notifier, adapters));
  app.use('/adapters', createAdapterRoutes(db, adapters, scheduler));

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      backend: db.backend,
      db: dbLabel,
      adapters: adapters.size,
      ts: new Date().toISOString(),
    });
  });

  // Dashboard — serve static files from dashboard/
  const DASHBOARD_DIR = process.env.DASHBOARD_DIR || join(__dirname, 'dashboard');
  if (existsSync(DASHBOARD_DIR)) {
    app.use('/dashboard', express.static(DASHBOARD_DIR));
  }

  // QuestBus SSE endpoint
  const BUS_PATH = process.env.BUS_PATH || join(__dirname, 'questbus', 'bus.jsonl');
  const sseClients = new Set();

  app.get('/bus/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.post('/bus/send', (req, res) => {
    const msg = req.body;
    if (!msg) return res.status(400).json({ error: 'body required' });
    const line = JSON.stringify({ ...msg, ts: msg.ts || new Date().toISOString() }) + '\n';
    import('fs').then(({ appendFileSync }) => {
      try { appendFileSync(BUS_PATH, line); } catch {}
    });
    for (const client of sseClients) {
      client.write(`data: ${line}\n`);
    }
    res.json({ ok: true });
  });

  app.get('/', (req, res) => {
    res.json({ service: 'QuestWorks', version: '2.0.0', docs: '/health' });
  });

  const PORT = process.env.PORT || config.server?.port || 8788;
  app.listen(PORT, () => {
    console.log(`[questworks] Server listening on port ${PORT}`);
    console.log(`[questworks] DB backend: ${db.backend} (${dbLabel})`);
    console.log(`[questworks] Adapters: ${[...adapters.keys()].join(', ') || 'none'}`);
    if (adapters.size > 0) scheduler.start();
  });
}

main().catch(err => {
  console.error('[questworks] Startup error:', err);
  process.exit(1);
});