import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import yaml from 'js-yaml';

import { initDb } from './db/migrations.mjs';
import { GitHubAdapter } from './adapters/github.mjs';
import { JiraAdapter } from './adapters/jira.mjs';
import { BeadsAdapter } from './adapters/beads.mjs';
import { SyncScheduler } from './sync/scheduler.mjs';
import { MattermostNotifier } from './mattermost/notify.mjs';
import { createTaskRoutes } from './routes/tasks.mjs';
import { createAdapterRoutes } from './routes/adapters.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
function loadConfig() {
  const configPath = process.env.QUESTWORKS_CONFIG || join(__dirname, 'config.yaml');
  if (!existsSync(configPath)) {
    console.warn(`[config] No config.yaml found at ${configPath}, using defaults`);
    return { adapters: [], mattermost: {}, sync: { interval_seconds: 60 }, server: { port: 8788 } };
  }
  const raw = readFileSync(configPath, 'utf8');
  // Expand $ENV_VAR references
  const expanded = raw.replace(/\$(\w+)/g, (_, name) => process.env[name] || '');
  return yaml.load(expanded);
}

function buildAdapters(adapterConfigs) {
  const map = new Map();
  const ADAPTER_TYPES = { github: GitHubAdapter, jira: JiraAdapter, beads: BeadsAdapter };
  for (const ac of (adapterConfigs || [])) {
    const Cls = ADAPTER_TYPES[ac.type];
    if (!Cls) { console.warn(`[config] Unknown adapter type: ${ac.type}`); continue; }
    map.set(ac.id, new Cls(ac.id, ac.config || {}));
    console.log(`[adapters] Registered ${ac.type} adapter: ${ac.id}`);
  }
  return map;
}

// --- Main ---
const config = loadConfig();
const DB_PATH = process.env.QUESTWORKS_DB || join(__dirname, 'questworks.db');
const db = initDb(DB_PATH);

const adapters = buildAdapters(config.adapters);
const notifier = new MattermostNotifier(config.mattermost || {});
const scheduler = new SyncScheduler(db, adapters, notifier, config.sync?.interval_seconds || 60);

const app = express();
app.use(express.json());

// Auth middleware (optional — skip if no token configured)
const AUTH_TOKEN = process.env.QUESTWORKS_TOKEN || config.server?.auth_token;
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if (req.path === '/health' || req.path === '/') return next();
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
    db: DB_PATH,
    adapters: adapters.size,
    ts: new Date().toISOString(),
  });
});

// Dashboard — serve static files from dashboard/
const DASHBOARD_DIR = process.env.DASHBOARD_DIR || join(__dirname, 'dashboard');
if (existsSync(DASHBOARD_DIR)) {
  app.use('/dashboard', express.static(DASHBOARD_DIR));
}

// QuestBus SSE endpoint (backwards compat with dashboard/server.mjs)
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

// Legacy: serve old dashboard as root if no index.html in dashboard/
app.get('/', (req, res) => {
  res.json({ service: 'QuestWorks', version: '2.0.0', docs: '/health' });
});

const PORT = process.env.PORT || config.server?.port || 8788;
app.listen(PORT, () => {
  console.log(`[questworks] Server listening on port ${PORT}`);
  console.log(`[questworks] DB: ${DB_PATH}`);
  console.log(`[questworks] Adapters: ${[...adapters.keys()].join(', ') || 'none'}`);
  if (adapters.size > 0) scheduler.start();
});
