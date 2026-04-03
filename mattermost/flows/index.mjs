/**
 * Conversational flow registry for /qw slash commands.
 *
 * Each flow exports:
 *   start(db, userId, channelId, args) → { message, done }
 *   step(db, conv, userText)           → { message, done, step?, data? }
 */
import { randomUUID } from 'crypto';
import { encrypt, decrypt } from '../crypto.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getData(conv) {
  if (typeof conv.data === 'object' && conv.data !== null) return conv.data;
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

async function fmtAdapters(db) {
  const rows = await db.query('SELECT * FROM adapters_config ORDER BY created_at', []);
  if (!rows.length) return '_No adapters configured._';
  return rows.map((a, i) => {
    const cfg = tryDecryptCfg(a.config_encrypted);
    const tok = maskToken(cfg.token);
    const target = cfg.repo || cfg.url || cfg.endpoint || '—';
    return `${i + 1}. \`${a.id}\` **${a.name}** [${a.type}] ${target} token=${tok} status=${a.status}`;
  }).join('\n');
}

// ── adapter_add_github (dialog-based) ────────────────────────────────────────

const adapter_add_github = {
  async start(db, userId, channelId, args) {
    return {
      dialog: true,
      done: true,
      dialogDef: {
        title: 'Add GitHub Adapter',
        submit_label: 'Add',
        elements: [
          { display_name: 'Repository', name: 'repo', type: 'text', placeholder: 'owner/repo', optional: false },
          { display_name: 'Personal Access Token', name: 'token', type: 'text', placeholder: 'ghp_...', optional: false },
          { display_name: 'Label filter', name: 'label', type: 'text', placeholder: 'questworks', optional: false },
          { display_name: 'Adapter name (optional)', name: 'name', type: 'text', optional: true },
        ],
      },
    };
  },
  async step(db, conv, userText) { return { message: 'Use `/qw adapter add github` to open the dialog.', done: true }; },
};

// ── adapter_add_beads (dialog-based) ──────────────────────────────────────────

const adapter_add_beads = {
  async start(db, userId, channelId, args) {
    return {
      dialog: true,
      done: true,
      dialogDef: {
        title: 'Add Beads Adapter',
        submit_label: 'Add',
        elements: [
          { display_name: 'Endpoint URL', name: 'endpoint', type: 'text', placeholder: 'https://...', optional: false },
          { display_name: 'API Token', name: 'token', type: 'text', placeholder: 'Paste your Beads API token', optional: false },
          { display_name: 'Board ID', name: 'board_id', type: 'text', placeholder: 'board-id', optional: false },
          { display_name: 'Adapter name (optional)', name: 'name', type: 'text', optional: true },
        ],
      },
    };
  },
  async step(db, conv, userText) { return { message: 'Use `/qw adapter add beads` to open the dialog.', done: true }; },
};

// ── adapter_add_jira (dialog-based) ───────────────────────────────────────────

const adapter_add_jira = {
  async start(db, userId, channelId, args) {
    return {
      dialog: true,
      done: true,
      dialogDef: {
        title: 'Add Jira Adapter',
        submit_label: 'Add',
        elements: [
          { display_name: 'Jira URL', name: 'url', type: 'text', placeholder: 'https://yourco.atlassian.net', optional: false },
          { display_name: 'API Token', name: 'token', type: 'text', placeholder: 'Paste your Jira API token', optional: false },
          { display_name: 'Project Key', name: 'project', type: 'text', placeholder: 'QUEST', optional: false },
          { display_name: 'Adapter name (optional)', name: 'name', type: 'text', optional: true },
        ],
      },
    };
  },
  async step(db, conv, userText) { return { message: 'Use `/qw adapter add jira` to open the dialog.', done: true }; },
};

// ── handleDialogSubmit ────────────────────────────────────────────────────────

export async function handleDialogSubmit(db, flowName, submission, adapters, scheduler) {
  if (flowName === 'adapter_add_jira') {
    const { url, token, project, name: rawName } = submission;
    if (!url || !token || !project) return '⚠️ URL, token, and project key are all required.';
    const name = rawName?.trim() || `jira-${project.trim().toLowerCase()}`;
    const id = randomUUID();
    const cfg = { url: url.trim(), token: token.trim(), project: project.trim().toUpperCase() };
    await db.run(`INSERT INTO adapters_config (id, type, name, config_encrypted, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
      [id, 'jira', name, encrypt(JSON.stringify(cfg)), new Date().toISOString()]);
    if (adapters) { const { JiraAdapter } = await import('../../adapters/jira.mjs'); adapters.set(id, new JiraAdapter(id, cfg)); }
    if (scheduler && !scheduler._timer) scheduler.start();
    if (scheduler) scheduler.syncAdapter(id).catch(err => console.error(`[dialog] jira sync failed: ${err.message}`));
    return `✅ Jira adapter **${name}** added (\`${id.slice(0, 8)}\`). Syncing in background…`;
  }
  if (flowName === 'adapter_add_github') {
    const { repo, token, label, name: rawName } = submission;
    if (!repo || !token || !label) return '⚠️ Repository, token, and label filter are all required.';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) return '⚠️ Repository must be in `owner/repo` format.';
    const slug = repo.trim().replace('/', '-');
    const name = rawName?.trim() || `github-${slug}`;
    const id = randomUUID();
    const cfg = { repo: repo.trim(), token: token.trim(), label_filter: label.trim() };
    await db.run(`INSERT INTO adapters_config (id, type, name, config_encrypted, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
      [id, 'github', name, encrypt(JSON.stringify(cfg)), new Date().toISOString()]);
    if (adapters) { const { GitHubAdapter } = await import('../../adapters/github.mjs'); adapters.set(id, new GitHubAdapter(id, cfg)); }
    if (scheduler && !scheduler._timer) scheduler.start();
    if (scheduler) scheduler.syncAdapter(id).catch(err => console.error(`[dialog] github sync failed: ${err.message}`));
    return `✅ GitHub adapter **${name}** added (\`${id.slice(0, 8)}\`). Syncing in background…`;
  }
  if (flowName === 'adapter_add_beads') {
    const { endpoint, token, board_id, name: rawName } = submission;
    if (!endpoint || !token || !board_id) return '⚠️ Endpoint, token, and board ID are all required.';
    const name = rawName?.trim() || `beads-${board_id.trim()}`;
    const id = randomUUID();
    const cfg = { endpoint: endpoint.trim(), token: token.trim(), board_id: board_id.trim() };
    await db.run(`INSERT INTO adapters_config (id, type, name, config_encrypted, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
      [id, 'beads', name, encrypt(JSON.stringify(cfg)), new Date().toISOString()]);
    if (adapters) { const { BeadsAdapter } = await import('../../adapters/beads.mjs'); adapters.set(id, new BeadsAdapter(id, cfg)); }
    if (scheduler && !scheduler._timer) scheduler.start();
    if (scheduler) scheduler.syncAdapter(id).catch(err => console.error(`[dialog] beads sync failed: ${err.message}`));
    return `✅ Beads adapter **${name}** added (\`${id.slice(0, 8)}\`). Syncing in background…`;
  }
  return `Unknown dialog flow: ${flowName}`;
}

// ── adapter_list ──────────────────────────────────────────────────────────────

const adapter_list = {
  async start(db, userId, channelId, args) {
    return { message: `**Configured Adapters**\n${await fmtAdapters(db)}`, done: true };
  },
  async step(db, conv, userText) { return { message: 'Done.', done: true }; },
};

// ── adapter_remove ────────────────────────────────────────────────────────────

const adapter_remove = {
  async start(db, userId, channelId, args) {
    const list = await fmtAdapters(db);
    return { message: `**Adapters:**\n${list}\n\nEnter the adapter ID to remove (or \`cancel\`):`, done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };
      const row = await db.queryOne('SELECT * FROM adapters_config WHERE id=?', [text]);
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
      await db.run('DELETE FROM adapters_config WHERE id=?', [data.adapterId]);
      return { message: `Adapter **${data.adapterName}** removed.`, done: true };
    }

    return { message: 'Unexpected state.', done: true };
  },
};

// ── adapter_sync ──────────────────────────────────────────────────────────────

const adapter_sync = {
  async start(db, userId, channelId, args) {
    const list = await fmtAdapters(db);
    return { message: `**Adapters:**\n${list}\n\nEnter adapter ID to sync, or \`all\`:`, done: false };
  },
  async step(db, conv, userText) {
    const text = userText.trim();
    if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };
    if (text.toLowerCase() === 'all') {
      const row = await db.queryOne("SELECT COUNT(*) as n FROM adapters_config WHERE status='active'", []);
      const n = row?.n || 0;
      return { message: `Sync queued for all ${n} active adapter(s). Tasks will update on next sync cycle.`, done: true };
    }
    const row = await db.queryOne('SELECT name FROM adapters_config WHERE id=?', [text]);
    if (!row) {
      return { message: `Adapter \`${text}\` not found. Enter a valid ID or \`all\`:`, done: false, data: getData(conv), step: 0 };
    }
    return { message: `Sync queued for **${row.name}**. Tasks will update on next sync cycle.`, done: true };
  },
};

// ── task_list ─────────────────────────────────────────────────────────────────

const task_list = {
  async start(db, userId, channelId, args) {
    const tasks = await db.query("SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at ASC LIMIT 20", []);
    return { message: `**Open Tasks (${tasks.length})**\n${fmtTasks(tasks)}`, done: true };
  },
  async step(db, conv, userText) { return { message: 'Done.', done: true }; },
};

// ── task_claim ────────────────────────────────────────────────────────────────

const task_claim = {
  async start(db, userId, channelId, args) {
    const tasks = await db.query("SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at DESC", []);
    if (!tasks.length) return { message: 'No open tasks available to claim.', done: true };
    return { message: `**Open Tasks:**\n${fmtTasks(tasks)}\n\nEnter task number or ID prefix to claim:`, done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();
    if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };

    const tasks = await db.query("SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at DESC", []);
    let task;
    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= tasks.length) {
      task = tasks[num - 1];
    } else {
      task = await db.queryOne("SELECT * FROM tasks WHERE id LIKE ? AND status='open' LIMIT 1", [text + '%']);
    }

    if (!task) {
      return { message: `Task not found. Enter a valid number or ID prefix (or \`cancel\`):`, done: false, data, step: 0 };
    }

    const now = new Date().toISOString();
    const result = await db.run(
      "UPDATE tasks SET status='claimed', assignee=?, claimed_at=?, updated_at=? WHERE id=? AND status='open'",
      [conv.user_id, now, now, task.id]
    );

    if (result.changes === 0) {
      return { message: `**${task.title}** was just claimed by someone else.`, done: true };
    }
    return { message: `You claimed **${task.title}**!${task.external_url ? `\n${task.external_url}` : ''}`, done: true };
  },
};

// ── task_done ─────────────────────────────────────────────────────────────────

const task_done = {
  async start(db, userId, channelId, args) {
    const tasks = await db.query(
      "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress') ORDER BY updated_at DESC",
      [userId]
    );
    if (!tasks.length) return { message: 'You have no claimed or in-progress tasks.', done: true };
    return { message: `**Your Tasks:**\n${fmtTasks(tasks)}\n\nEnter task number or ID prefix to mark done:`, done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };
      const tasks = await db.query(
        "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress') ORDER BY updated_at DESC",
        [conv.user_id]
      );
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
      await db.run("UPDATE tasks SET status='done', updated_at=? WHERE id=?", [now, data.taskId]);
      if (text) {
        await db.run(
          "INSERT INTO task_history (task_id, actor, action, note, ts) VALUES (?, ?, 'done', ?, ?)",
          [data.taskId, conv.user_id, text, now]
        );
      }
      return { message: `**${data.taskTitle}** marked as done.`, done: true };
    }

    return { message: 'Unexpected state.', done: true };
  },
};

// ── task_block ────────────────────────────────────────────────────────────────

const task_block = {
  async start(db, userId, channelId, args) {
    const tasks = await db.query(
      "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress') ORDER BY updated_at DESC",
      [userId]
    );
    if (!tasks.length) return { message: 'You have no in-progress tasks.', done: true };
    return { message: `**Your Tasks:**\n${fmtTasks(tasks)}\n\nEnter task number or ID prefix to mark blocked:`, done: false };
  },
  async step(db, conv, userText) {
    const data = getData(conv);
    const text = userText.trim();

    if (conv.step === 0) {
      if (text.toLowerCase() === 'cancel') return { message: 'Cancelled.', done: true };
      const tasks = await db.query(
        "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress') ORDER BY updated_at DESC",
        [conv.user_id]
      );
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
      await db.run("UPDATE tasks SET status='blocked', updated_at=? WHERE id=?", [now, data.taskId]);
      await db.run(
        "INSERT INTO task_history (task_id, actor, action, note, ts) VALUES (?, ?, 'blocked', ?, ?)",
        [data.taskId, conv.user_id, reason, now]
      );
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
      await db.run(
        "INSERT INTO tasks (id, title, description, status, source, external_id, priority, labels, created_at, updated_at, metadata) VALUES (?, ?, ?, 'open', 'manual', ?, ?, '[]', ?, ?, '{}')",
        [id, data.title, data.description || '', id, priority, now, now]
      );
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
    const row = await db.queryOne("SELECT config_encrypted FROM adapters_config WHERE type='github' AND status='active' LIMIT 1", []);
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
    await db.run(
      "INSERT INTO tasks (id, title, description, status, source, external_id, external_url, priority, labels, created_at, updated_at, metadata) VALUES (?, ?, ?, 'open', 'github', ?, ?, 0, ?, ?, ?, '{}') ON CONFLICT (source, external_id) DO NOTHING",
      [id, issue.title, (issue.body || '').slice(0, 500), extId, issue.html_url, JSON.stringify((issue.labels || []).map(l => l.name)), now, now]
    );
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

  const row = await db.queryOne("SELECT config_encrypted FROM adapters_config WHERE type='jira' AND status='active' LIMIT 1", []);
  if (!row) return { message: 'No Jira adapter configured. Add one with `/qw adapter add jira` first.', done: true };

  let jiraUrl, jiraToken;
  try {
    const cfg = tryDecryptCfg(row.config_encrypted);
    jiraUrl = cfg.url;
    const jiraEmail = cfg.email || '';
    jiraToken = cfg.token;
  } catch { return { message: 'Failed to read Jira config.', done: true }; }

  let issue;
  try {
    const resp = await fetch(`${jiraUrl}/rest/api/3/issue/${issueKey}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')}`,
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
    await db.run(
      "INSERT INTO tasks (id, title, description, status, source, external_id, external_url, priority, labels, created_at, updated_at, metadata) VALUES (?, ?, ?, 'open', 'jira', ?, ?, 0, '[]', ?, ?, '{}') ON CONFLICT (source, external_id) DO NOTHING",
      [id, title, desc, issueKey, `${jiraUrl}/browse/${issueKey}`, now, now]
    );
  } catch (err) {
    if (err.message.includes('UNIQUE')) return { message: `Task for ${issueKey} already exists.`, done: true };
    return { message: `DB error: ${err.message}`, done: true };
  }
  return { message: `Imported Jira issue: **${title}**\n${jiraUrl}/browse/${issueKey}`, done: true };
}

async function _addBeads(db, data, text) {
  const row = await db.queryOne("SELECT config_encrypted FROM adapters_config WHERE type='beads' AND status='active' LIMIT 1", []);
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
    await db.run(
      "INSERT INTO tasks (id, title, description, status, source, external_id, external_url, priority, labels, created_at, updated_at, metadata) VALUES (?, ?, ?, 'open', 'beads', ?, ?, 0, '[]', ?, ?, '{}') ON CONFLICT (source, external_id) DO NOTHING",
      [id, task.title || taskId, (task.description || '').slice(0, 500), taskId, task.url || `${endpoint}/tasks/${taskId}`, now, now]
    );
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
    await db.run(`INSERT INTO config (key, value) VALUES ('mm_channel', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [channel]);
    return { message: `Notification channel set to **#${channel}**.`, done: true };
  },
};

// ── config_set_sync_interval ──────────────────────────────────────────────────

const config_set_sync_interval = {
  async start(db, userId, channelId, args) {
    const row = await db.queryOne("SELECT value FROM config WHERE key='sync_interval_seconds'", []);
    const current = row?.value || '60';
    return { message: `Current sync interval: **${current}s**\nEnter new interval in seconds (min 10):`, done: false };
  },
  async step(db, conv, userText) {
    const val = parseInt(userText.trim(), 10);
    if (isNaN(val) || val < 10) return { message: 'Enter a number ≥ 10:', done: false, data: getData(conv), step: 0 };
    await db.run(`INSERT INTO config (key, value) VALUES ('sync_interval_seconds', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [String(val)]);
    return { message: `Sync interval set to **${val}s**. Restart server to apply.`, done: true };
  },
};

// ── config_show ───────────────────────────────────────────────────────────────

const config_show = {
  async start(db, userId, channelId, args) {
    const rows = await db.query('SELECT key, value FROM config ORDER BY key', []);
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
