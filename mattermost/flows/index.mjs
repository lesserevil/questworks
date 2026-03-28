/**
 * Conversational flow registry for /qw slash commands.
 *
 * Each flow exports:
 *   start(db, userId, channelId, args) → { message, done }
 *   step(db, conv, userText)           → { message, done, step?, data? }
 *
 * When done:true is returned no conversation is created/kept.
 * When done:false, `step` sets the new step number, `data` sets new data object.
 * If `step` is omitted it defaults to conv.step + 1; if `data` is omitted the
 * current data is preserved.
 */
import { randomUUID } from 'crypto';
import { encrypt, decrypt } from '../crypto.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getData(conv) {
  try { return JSON.parse(conv.data || '{}'); } catch { return {}; }
}

function tryDecryptCfg(encStr) {
  try { return JSON.parse(decrypt(encStr)); } catch { return {}; }
}

function maskToken(token) {
  if (!token || String(token).length < 4) return '****';
  return '...' + String(token).slice(-4);
}

function isSkip(text) {
  const t = (text || '').trim().toLowerCase();
  return t === '' || t === 'skip' || t === 'none' || t === '-';
}

function fmtTasks(tasks) {
  if (!tasks.length) return '_No tasks found._';
  return tasks.map((t, i) =>
    `${i + 1}. \`${t.id.slice(0, 8)}\` **${t.title.slice(0, 50)}** — ${t.status} [${t.source}]`
  ).join('\n');
}

function fmtAdapters(db) {
  const rows = db.prepare('SELECT * FROM adapters_config ORDER BY created_at').all();
  if (!rows.length) return '_No adapters configured._';
  return rows.map((a, i) => {
    const cfg = tryDecryptCfg(a.config_encrypted);
    const tok = maskToken(cfg.token);
    const target = cfg.repo || cfg.url || cfg.endpoint || '—';
    return `${i + 1}. \`${a.id}\` **${a.name}** [${a.type}] ${target} token=${tok} status=${a.status}`;
  }).join('\n');
}

// ── adapter_add_github ────────────────────────────────────────────────────────

const adapter_add_github = {
  async start(db, userId, channelId, args) {
    return { message: 'Adding a GitHub adapter.\nStep 1/4 — Repo (`owner/repo`):', done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(text)) {
        return { message: 'Invalid format. Use `owner/repo` (e.g. `acme/widget`):', done: false, data, step: 0 };
      }
      return { message: 'Step 2/4 — Paste your GitHub personal access token:', done: false, data: { ...data, repo: text }, step: 1 };
    }

    if (conv.step === 1) {
      if (!text) return { message: 'Token cannot be empty:', done: false, data, step: 1 };
      return { message: 'Step 3/4 — Label filter (required, e.g. `questworks`):', done: false, data: { ...data, token: encrypt(text) }, step: 2 };
    }

    if (conv.step === 2) {
      if (!text) return { message: 'Label filter is required. Enter a label (e.g. `questworks`):', done: false, data, step: 2 };
      const slug = data.repo.replace('/', '-');
      return { message: `Step 4/4 — Adapter name (optional, Enter for \`github-${slug}\`):`, done: false, data: { ...data, label: text }, step: 3 };
    }

    if (conv.step === 3) {
      const slug = data.repo.replace('/', '-');
      const name = isSkip(text) ? `github-${slug}` : text;
      const id = randomUUID();
      const rawToken = decrypt(data.token);
      const cfg = { repo: data.repo, token: rawToken, label_filter: data.label };
      db.prepare('INSERT INTO adapters_config (id, type, name, config_encrypted) VALUES (?, ?, ?, ?)').run(id, 'github', name, encrypt(JSON.stringify(cfg)));
      return { message: `GitHub adapter **${name}** added (\`${id.slice(0, 8)}\`). Sync runs on next scheduled interval.`, done: true };
    }

    return { message: 'Unexpected state. Try starting over.', done: true };
  },
};

// ── adapter_add_beads ─────────────────────────────────────────────────────────

const adapter_add_beads = {
  async start(db, userId, channelId, args) {
    return { message: 'Adding a Beads adapter.\nStep 1/4 — Endpoint URL:', done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (!text) return { message: 'Endpoint cannot be empty:', done: false, data, step: 0 };
      return { message: 'Step 2/4 — Beads API token:', done: false, data: { ...data, endpoint: text }, step: 1 };
    }
    if (conv.step === 1) {
      if (!text) return { message: 'Token cannot be empty:', done: false, data, step: 1 };
      return { message: 'Step 3/4 — Board ID:', done: false, data: { ...data, token: encrypt(text) }, step: 2 };
    }
    if (conv.step === 2) {
      if (!text) return { message: 'Board ID cannot be empty:', done: false, data, step: 2 };
      return { message: 'Step 4/4 — Adapter name (optional, Enter to skip):', done: false, data: { ...data, board_id: text }, step: 3 };
    }
    if (conv.step === 3) {
      const name = isSkip(text) ? `beads-${data.board_id}` : text;
      const id = randomUUID();
      const cfg = { endpoint: data.endpoint, token: decrypt(data.token), board_id: data.board_id };
      db.prepare('INSERT INTO adapters_config (id, type, name, config_encrypted) VALUES (?, ?, ?, ?)').run(id, 'beads', name, encrypt(JSON.stringify(cfg)));
      return { message: `Beads adapter **${name}** added (\`${id.slice(0, 8)}\`).`, done: true };
    }

    return { message: 'Unexpected state. Try starting over.', done: true };
  },
};

// ── adapter_add_jira ──────────────────────────────────────────────────────────

const adapter_add_jira = {
  async start(db, userId, channelId, args) {
    return { message: 'Adding a Jira adapter.\nStep 1/4 — Jira URL (e.g. `https://company.atlassian.net`):', done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (!text) return { message: 'URL cannot be empty:', done: false, data, step: 0 };
      return { message: 'Step 2/4 — Jira API token:', done: false, data: { ...data, url: text }, step: 1 };
    }
    if (conv.step === 1) {
      if (!text) return { message: 'Token cannot be empty:', done: false, data, step: 1 };
      return { message: 'Step 3/4 — Project key (e.g. `QUEST`):', done: false, data: { ...data, token: encrypt(text) }, step: 2 };
    }
    if (conv.step === 2) {
      if (!text) return { message: 'Project key cannot be empty:', done: false, data, step: 2 };
      return { message: 'Step 4/4 — Adapter name (optional, Enter to skip):', done: false, data: { ...data, project: text }, step: 3 };
    }
    if (conv.step === 3) {
      const name = isSkip(text) ? `jira-${data.project.toLowerCase()}` : text;
      const id = randomUUID();
      const cfg = { url: data.url, token: decrypt(data.token), project: data.project };
      db.prepare('INSERT INTO adapters_config (id, type, name, config_encrypted) VALUES (?, ?, ?, ?)').run(id, 'jira', name, encrypt(JSON.stringify(cfg)));
      return { message: `Jira adapter **${name}** added (\`${id.slice(0, 8)}\`).`, done: true };
    }

    return { message: 'Unexpected state. Try starting over.', done: true };
  },
};

// ── adapter_list ──────────────────────────────────────────────────────────────

const adapter_list = {
  async start(db, userId, channelId, args) {
    return { message: `**Configured Adapters**\n${fmtAdapters(db)}`, done: true };
  },
  async step(db, conv, userText) { return { message: 'Done.', done: true }; },
};

// ── adapter_remove ────────────────────────────────────────────────────────────

const adapter_remove = {
  async start(db, userId, channelId, args) {
    const list = fmtAdapters(db);
    return { message: `**Adapters:**\n${list}\n\nEnter the adapter ID to remove (or \`cancel\`):`, done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };
      const row = db.prepare('SELECT * FROM adapters_config WHERE id=?').get(text);
      if (!row) {
        return { message: `Adapter \`${text}\` not found. Enter a valid ID or \`cancel\`:`, done: false, data, step: 0 };
      }
      return {
        message: `Remove **${row.name}** (${row.type}, \`${row.id}\`)?\nType **yes** to confirm or **no** to cancel:`,
        done: false,
        data: { adapterId: row.id, adapterName: row.name },
        step: 1,
      };
    }

    if (conv.step === 1) {
      if (text.toLowerCase() !== 'yes') return { message: 'Removal cancelled.', done: true };
      db.prepare('DELETE FROM adapters_config WHERE id=?').run(data.adapterId);
      return { message: `Adapter **${data.adapterName}** removed.`, done: true };
    }

    return { message: 'Unexpected state.', done: true };
  },
};

// ── adapter_sync ──────────────────────────────────────────────────────────────

const adapter_sync = {
  async start(db, userId, channelId, args) {
    const list = fmtAdapters(db);
    return { message: `**Adapters:**\n${list}\n\nEnter adapter ID to sync, or \`all\`:`, done: false };
  },
  async step(db, conv, userText) {
    const text = userText.trim();
    if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };
    if (text.toLowerCase() === 'all') {
      const n = db.prepare("SELECT COUNT(*) as n FROM adapters_config WHERE status='active'").get().n;
      return { message: `Sync queued for all ${n} active adapter(s). Tasks will update on next sync cycle.`, done: true };
    }
    const row = db.prepare('SELECT name FROM adapters_config WHERE id=?').get(text);
    if (!row) {
      return { message: `Adapter \`${text}\` not found. Enter a valid ID or \`all\`:`, done: false, data: getData(conv), step: 0 };
    }
    return { message: `Sync queued for **${row.name}**. Tasks will update on next sync cycle.`, done: true };
  },
};

// ── task_list ─────────────────────────────────────────────────────────────────

const task_list = {
  async start(db, userId, channelId, args) {
    const tasks = db.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at ASC LIMIT 20").all();
    return { message: `**Open Tasks (${tasks.length})**\n${fmtTasks(tasks)}`, done: true };
  },
  async step(db, conv, userText) { return { message: 'Done.', done: true }; },
};

// ── task_claim ────────────────────────────────────────────────────────────────

const task_claim = {
  async start(db, userId, channelId, args) {
    const tasks = db.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at ASC LIMIT 20").all();
    if (!tasks.length) return { message: 'No open tasks available to claim.', done: true };
    return { message: `**Open Tasks:**\n${fmtTasks(tasks)}\n\nEnter task number or ID prefix to claim:`, done: false };
  },
  async step(db, conv, userText) {
    const text = userText.trim();
    if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };

    const tasks = db.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at ASC LIMIT 20").all();
    let task;
    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= tasks.length) {
      task = tasks[num - 1];
    } else {
      task = db.prepare("SELECT * FROM tasks WHERE id LIKE ? AND status='open' LIMIT 1").get(text + '%');
    }

    if (!task) {
      return { message: `Task not found. Enter a valid number or ID prefix (or \`cancel\`):`, done: false, data: getData(conv), step: 0 };
    }

    const now = new Date().toISOString();
    const result = db.prepare(
      "UPDATE tasks SET status='claimed', assignee=?, claimed_at=?, updated_at=? WHERE id=? AND status='open'"
    ).run(conv.user_id, now, now, task.id);

    if (result.changes === 0) {
      return { message: `**${task.title}** was just claimed by someone else.`, done: true };
    }
    return { message: `You claimed **${task.title}**!${task.external_url ? `\n${task.external_url}` : ''}`, done: true };
  },
};

// ── task_done ─────────────────────────────────────────────────────────────────

const task_done = {
  async start(db, userId, channelId, args) {
    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress') ORDER BY updated_at DESC"
    ).all(userId);
    if (!tasks.length) return { message: 'You have no claimed or in-progress tasks.', done: true };
    return { message: `**Your Tasks:**\n${fmtTasks(tasks)}\n\nEnter task number or ID prefix to mark done:`, done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };
      const tasks = db.prepare(
        "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress') ORDER BY updated_at DESC"
      ).all(conv.user_id);
      let task;
      const num = parseInt(text, 10);
      if (!isNaN(num) && num >= 1 && num <= tasks.length) {
        task = tasks[num - 1];
      } else {
        task = tasks.find(t => t.id === text || t.id.startsWith(text));
      }
      if (!task) return { message: `Task not found. Enter a valid number or ID (or \`cancel\`):`, done: false, data, step: 0 };
      return { message: `Add a note for **${task.title}** (optional, Enter to skip):`, done: false, data: { taskId: task.id, taskTitle: task.title }, step: 1 };
    }

    if (conv.step === 1) {
      const now = new Date().toISOString();
      db.prepare("UPDATE tasks SET status='done', updated_at=? WHERE id=?").run(now, data.taskId);
      if (text) {
        db.prepare("INSERT INTO task_history (task_id, actor, action, note, ts) VALUES (?, ?, 'done', ?, ?)").run(data.taskId, conv.user_id, text, now);
      }
      return { message: `**${data.taskTitle}** marked as done.`, done: true };
    }

    return { message: 'Unexpected state.', done: true };
  },
};

// ── task_block ────────────────────────────────────────────────────────────────

const task_block = {
  async start(db, userId, channelId, args) {
    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress') ORDER BY updated_at DESC"
    ).all(userId);
    if (!tasks.length) return { message: 'You have no in-progress tasks.', done: true };
    return { message: `**Your Tasks:**\n${fmtTasks(tasks)}\n\nEnter task number or ID prefix to mark blocked:`, done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };
      const tasks = db.prepare(
        "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress') ORDER BY updated_at DESC"
      ).all(conv.user_id);
      let task;
      const num = parseInt(text, 10);
      if (!isNaN(num) && num >= 1 && num <= tasks.length) {
        task = tasks[num - 1];
      } else {
        task = tasks.find(t => t.id === text || t.id.startsWith(text));
      }
      if (!task) return { message: `Task not found. Enter a valid number or ID (or \`cancel\`):`, done: false, data, step: 0 };
      return { message: `What's blocking **${task.title}**?`, done: false, data: { taskId: task.id, taskTitle: task.title }, step: 1 };
    }

    if (conv.step === 1) {
      const reason = text || '(no reason given)';
      const now = new Date().toISOString();
      db.prepare("UPDATE tasks SET status='blocked', updated_at=? WHERE id=?").run(now, data.taskId);
      db.prepare("INSERT INTO task_history (task_id, actor, action, note, ts) VALUES (?, ?, 'blocked', ?, ?)").run(data.taskId, conv.user_id, reason, now);
      return { message: `**${data.taskTitle}** marked as blocked.\nReason: ${reason}`, done: true };
    }

    return { message: 'Unexpected state.', done: true };
  },
};

// ── task_add ──────────────────────────────────────────────────────────────────

const task_add = {
  async start(db, userId, channelId, args) {
    return { message: 'Add a task. Source type?\nOptions: **github**, **jira**, **beads**, **manual**', done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      const t = text.toLowerCase();
      if (!['github', 'jira', 'beads', 'manual'].includes(t)) {
        return { message: 'Please choose: **github**, **jira**, **beads**, or **manual**', done: false, data, step: 0 };
      }
      const prompts = {
        github: 'Enter `owner/repo#number` or a GitHub issue URL:',
        jira: 'Enter Jira issue key (e.g. `QUEST-123`) or a Jira browse URL:',
        beads: 'Enter Beads task ID or URL:',
        manual: 'Enter the task title:',
      };
      return { message: prompts[t], done: false, data: { type: t }, step: 1 };
    }

    if (conv.step === 1) {
      if (data.type === 'github') return _addGithub(db, data, text);
      if (data.type === 'jira') return _addJira(db, data, text);
      if (data.type === 'beads') return _addBeads(db, data, text);
      if (data.type === 'manual') {
        if (!text) return { message: 'Title cannot be empty:', done: false, data, step: 1 };
        return { message: 'Description (optional, Enter to skip):', done: false, data: { ...data, title: text }, step: 2 };
      }
    }

    if (conv.step === 2 && data.type === 'manual') {
      return {
        message: 'Priority: **1** (high), **2** (medium), **3** (low) — Enter for default (2):',
        done: false,
        data: { ...data, description: isSkip(text) ? null : text },
        step: 3,
      };
    }

    if (conv.step === 3 && data.type === 'manual') {
      const raw = text === '' ? '2' : text;
      const priority = parseInt(raw, 10);
      if (isNaN(priority) || priority < 1 || priority > 3) {
        return { message: 'Enter 1, 2, or 3 (or Enter for default 2):', done: false, data, step: 3 };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO tasks (id, title, description, status, source, external_id, priority, labels, created_at, updated_at, metadata) VALUES (?, ?, ?, 'open', 'manual', ?, ?, '[]', ?, ?, '{}')"
      ).run(id, data.title, data.description || '', id, priority, now, now);
      return { message: `Task **${data.title}** created (\`${id.slice(0, 8)}\`).`, done: true };
    }

    return { message: 'Unexpected state.', done: true };
  },
};

async function _addGithub(db, data, text) {
  let owner, repo, number;
  const urlMatch = text.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  const shortMatch = text.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (urlMatch) { [, owner, repo, number] = urlMatch; }
  else if (shortMatch) { [, owner, repo, number] = shortMatch; }
  else return { message: 'Invalid format. Use `owner/repo#number` or a GitHub issue URL:', done: false, data, step: 1 };

  let ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    const row = db.prepare("SELECT config_encrypted FROM adapters_config WHERE type='github' AND status='active' LIMIT 1").get();
    if (row) {
      const cfg = tryDecryptCfg(row.config_encrypted);
      ghToken = cfg.token || null;
    }
  }

  const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'QuestWorks/2.0' };
  if (ghToken) headers.Authorization = `token ${ghToken}`;

  let issue;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, { headers });
    if (!resp.ok) return { message: `GitHub API error ${resp.status}: ${resp.statusText}`, done: true };
    issue = await resp.json();
  } catch (err) {
    return { message: `Failed to reach GitHub: ${err.message}`, done: true };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const extId = `${owner}/${repo}#${number}`;
  try {
    db.prepare(
      "INSERT OR IGNORE INTO tasks (id, title, description, status, source, external_id, external_url, priority, labels, created_at, updated_at, metadata) VALUES (?, ?, ?, 'open', 'github', ?, ?, 0, ?, ?, ?, '{}')"
    ).run(id, issue.title, (issue.body || '').slice(0, 500), extId, issue.html_url, JSON.stringify((issue.labels || []).map(l => l.name)), now, now);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return { message: `Task for ${extId} already exists.`, done: true };
    return { message: `DB error: ${err.message}`, done: true };
  }
  return { message: `Imported GitHub issue: **${issue.title}**\n${issue.html_url}`, done: true };
}

async function _addJira(db, data, text) {
  let issueKey;
  const urlMatch = text.match(/\/browse\/([A-Z]+-\d+)/i);
  const keyMatch = text.match(/^([A-Z]+-\d+)$/i);
  if (urlMatch) issueKey = urlMatch[1].toUpperCase();
  else if (keyMatch) issueKey = keyMatch[1].toUpperCase();
  else return { message: 'Invalid format. Use `PROJECT-123` or a Jira browse URL:', done: false, data, step: 1 };

  const row = db.prepare("SELECT config_encrypted FROM adapters_config WHERE type='jira' AND status='active' LIMIT 1").get();
  if (!row) return { message: 'No Jira adapter configured. Add one with `/qw adapter add jira` first.', done: true };

  let jiraUrl, jiraToken;
  try {
    const cfg = tryDecryptCfg(row.config_encrypted);
    jiraUrl = cfg.url;
    jiraToken = cfg.token;
  } catch { return { message: 'Failed to read Jira config.', done: true }; }

  let issue;
  try {
    const resp = await fetch(`${jiraUrl}/rest/api/3/issue/${issueKey}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`user:${jiraToken}`).toString('base64')}`,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) return { message: `Jira API error ${resp.status}`, done: true };
    issue = await resp.json();
  } catch (err) {
    return { message: `Failed to reach Jira: ${err.message}`, done: true };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const title = issue.fields?.summary || issueKey;
  const desc = (issue.fields?.description?.content?.[0]?.content?.[0]?.text || '').slice(0, 500);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO tasks (id, title, description, status, source, external_id, external_url, priority, labels, created_at, updated_at, metadata) VALUES (?, ?, ?, 'open', 'jira', ?, ?, 0, '[]', ?, ?, '{}')"
    ).run(id, title, desc, issueKey, `${jiraUrl}/browse/${issueKey}`, now, now);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return { message: `Task for ${issueKey} already exists.`, done: true };
    return { message: `DB error: ${err.message}`, done: true };
  }
  return { message: `Imported Jira issue: **${title}**\n${jiraUrl}/browse/${issueKey}`, done: true };
}

async function _addBeads(db, data, text) {
  const row = db.prepare("SELECT config_encrypted FROM adapters_config WHERE type='beads' AND status='active' LIMIT 1").get();
  if (!row) return { message: 'No Beads adapter configured. Add one with `/qw adapter add beads` first.', done: true };

  let endpoint, beadsToken;
  try {
    const cfg = tryDecryptCfg(row.config_encrypted);
    endpoint = cfg.endpoint;
    beadsToken = cfg.token;
  } catch { return { message: 'Failed to read Beads config.', done: true }; }

  const taskId = text.includes('/') ? text.split('/').pop().split('?')[0] : text;

  let task;
  try {
    const resp = await fetch(`${endpoint}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${beadsToken}` },
    });
    if (!resp.ok) return { message: `Beads API error ${resp.status}`, done: true };
    task = await resp.json();
  } catch (err) {
    return { message: `Failed to reach Beads: ${err.message}`, done: true };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(
      "INSERT OR IGNORE INTO tasks (id, title, description, status, source, external_id, external_url, priority, labels, created_at, updated_at, metadata) VALUES (?, ?, ?, 'open', 'beads', ?, ?, 0, '[]', ?, ?, '{}')"
    ).run(id, task.title || taskId, (task.description || '').slice(0, 500), taskId, task.url || `${endpoint}/tasks/${taskId}`, now, now);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return { message: `Task for beads:${taskId} already exists.`, done: true };
    return { message: `DB error: ${err.message}`, done: true };
  }
  return { message: `Imported Beads task: **${task.title || taskId}**`, done: true };
}

// ── config_set_channel ────────────────────────────────────────────────────────

const config_set_channel = {
  async start(db, userId, channelId, args) {
    return { message: 'Enter the Mattermost channel name for task notifications (e.g. `paperwork`):', done: false };
  },
  async step(db, conv, userText) {
    const channel = userText.trim().replace(/^#/, '');
    if (!channel) return { message: 'Channel name cannot be empty:', done: false, data: getData(conv), step: 0 };
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('mm_channel', ?)").run(channel);
    return { message: `Notification channel set to **#${channel}**.`, done: true };
  },
};

// ── config_set_sync_interval ──────────────────────────────────────────────────

const config_set_sync_interval = {
  async start(db, userId, channelId, args) {
    const row = db.prepare("SELECT value FROM config WHERE key='sync_interval_seconds'").get();
    const current = row?.value || '60';
    return { message: `Current sync interval: **${current}s**\nEnter new interval in seconds (min 10):`, done: false };
  },
  async step(db, conv, userText) {
    const val = parseInt(userText.trim(), 10);
    if (isNaN(val) || val < 10) return { message: 'Enter a number ≥ 10:', done: false, data: getData(conv), step: 0 };
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('sync_interval_seconds', ?)").run(String(val));
    return { message: `Sync interval set to **${val}s**. Restart server to apply.`, done: true };
  },
};

// ── config_show ───────────────────────────────────────────────────────────────

const config_show = {
  async start(db, userId, channelId, args) {
    const rows = db.prepare('SELECT key, value FROM config ORDER BY key').all();
    if (!rows.length) return { message: 'No configuration set.', done: true };
    const lines = rows.map(r => {
      const v = (r.key.includes('token') || r.key.includes('secret')) ? `...${r.value.slice(-4)}` : r.value;
      return `**${r.key}**: ${v}`;
    });
    return { message: `**Configuration**\n${lines.join('\n')}`, done: true };
  },
  async step(db, conv, userText) { return { message: 'Done.', done: true }; },
};

// ── help ──────────────────────────────────────────────────────────────────────

const help = {
  async start(db, userId, channelId, args) {
    return {
      message: `**QuestWorks** \`/qw\` commands

**Adapters**
\`/qw adapter add github\` — Add a GitHub Issues adapter
\`/qw adapter add beads\`  — Add a Beads board adapter
\`/qw adapter add jira\`   — Add a Jira project adapter
\`/qw adapter list\`       — List configured adapters
\`/qw adapter remove\`     — Remove an adapter
\`/qw adapter sync\`       — Trigger a manual sync

**Tasks**
\`/qw task list\`   — List open tasks
\`/qw task claim\`  — Claim an open task
\`/qw task done\`   — Mark your task as done
\`/qw task block\`  — Mark your task as blocked
\`/qw task add\`    — Add a task (GitHub/Jira/Beads/manual)

**Config**
\`/qw config set channel\`        — Set notification channel
\`/qw config set sync-interval\`  — Set sync interval (seconds)
\`/qw config show\`               — Show current configuration

\`/qw help\`  — This message`,
      done: true,
    };
  },
  async step(db, conv, userText) { return { message: 'Done.', done: true }; },
};

// ── Export ────────────────────────────────────────────────────────────────────

export const flows = {
  adapter_add_github,
  adapter_add_beads,
  adapter_add_jira,
  adapter_list,
  adapter_remove,
  adapter_sync,
  task_list,
  task_claim,
  task_done,
  task_block,
  task_add,
  config_set_channel,
  config_set_sync_interval,
  config_show,
  help,
};
