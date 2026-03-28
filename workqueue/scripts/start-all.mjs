#!/usr/bin/env node
/**
 * start-all.mjs — process manager for QuestWorks
 *
 * Starts webhook-handler.mjs as a persistent child process (port 3000),
 * and runs bandit-watchdog.mjs on a 15-minute interval.
 *
 * Usage:
 *   node start-all.mjs [--queue path/to/queue.json] [--channel-map path/to/channel-map.json]
 */

import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Passthrough CLI args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cliArg = (name) => { const i = args.indexOf(name); return i >= 0 ? [name, args[i + 1]] : []; };
const passthroughArgs = [...cliArg('--queue'), ...cliArg('--channel-map')];

// ── Webhook handler (persistent, restart on crash) ────────────────────────────

let webhookProc = null;

function startWebhook() {
  const script = resolve(__dirname, 'webhook-handler.mjs');
  webhookProc = spawn(process.execPath, [script, '--port', '3000', ...passthroughArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  console.log(`[start-all] webhook-handler started (pid ${webhookProc.pid})`);

  webhookProc.on('exit', (code, signal) => {
    if (signal === 'SIGTERM') return; // intentional shutdown
    console.log(`[start-all] webhook-handler exited (code=${code}), restarting in 5s…`);
    setTimeout(startWebhook, 5000);
  });
}

startWebhook();

// ── Bandit watchdog (one-shot, every 15 minutes) ──────────────────────────────

function runWatchdog() {
  const script = resolve(__dirname, 'bandit-watchdog.mjs');
  const ts = new Date().toISOString();
  console.log(`[start-all] ${ts} — running bandit-watchdog`);

  const proc = spawn(process.execPath, [script, ...passthroughArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MM_BASE_URL: process.env.MM_BASE_URL,
      MM_BOT_TOKEN: process.env.MM_BOT_TOKEN,
    },
  });

  proc.on('exit', (code) => {
    if (code !== 0) console.log(`[start-all] bandit-watchdog exited with code ${code}`);
  });
}

runWatchdog(); // run immediately on start
const watchdogInterval = setInterval(runWatchdog, 15 * 60 * 1000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[start-all] SIGTERM received, shutting down…');
  clearInterval(watchdogInterval);
  if (webhookProc) webhookProc.kill('SIGTERM');
  process.exit(0);
});
