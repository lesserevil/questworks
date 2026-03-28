/**
 * Flow: /qw task claim
 * Step 1 — Show open tasks, ask which to claim
 * Done  — Atomic claim, confirm (or re-ask if already taken)
 */

function formatTaskList(tasks) {
  if (!tasks.length) return '_No open tasks._';
  const lines = [
    '| # | ID | Title | Source | Priority |',
    '|---|---|---|---|---|',
  ];
  tasks.slice(0, 15).forEach((t, i) => {
    const title = t.title.length > 45 ? t.title.slice(0, 42) + '...' : t.title;
    lines.push(`| ${i + 1} | \`${t.id.slice(0, 8)}\` | ${title} | ${t.source} | ${t.priority} |`);
  });
  if (tasks.length > 15) lines.push(`_...and ${tasks.length - 15} more_`);
  return lines.join('\n');
}

export async function start(ctx, conv) {
  const { db } = ctx;
  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at DESC"
  ).all();
  if (!tasks.length) return { reply: 'No open tasks available to claim.', done: true };
  return {
    reply: formatTaskList(tasks) + '\n\nWhich task do you want to claim? (enter the `#` or id)',
  };
}

export async function step(ctx, stepNum, message, data) {
  const { db, notifier } = ctx;
  const userName = data.mm_user_name || 'unknown';
  const text = message.trim();

  if (stepNum === 1) {
    // Re-fetch open tasks to resolve by number
    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at DESC"
    ).all();

    let taskId;
    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= tasks.length) {
      taskId = tasks[num - 1].id;
    } else {
      const match = tasks.find(t => t.id === text || t.id.startsWith(text));
      taskId = match?.id || null;
    }

    if (!taskId) {
      return {
        reply: "Couldn't find that task. Enter a `#` from the list or a task id:",
        nextStep: 1, newData: data, done: false,
      };
    }

    const claimTx = db.transaction(() => {
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      if (!task) return { error: 'not_found' };
      if (task.status !== 'open' || task.assignee) return { error: 'claimed', assignee: task.assignee };
      const now = new Date().toISOString();
      db.prepare(`UPDATE tasks SET status='claimed', assignee=?, claimed_at=?, updated_at=? WHERE id=?`)
        .run(userName, now, now, task.id);
      db.prepare(`INSERT INTO task_history (task_id, actor, action, old_value, new_value, ts) VALUES (?,?,?,?,?,?)`)
        .run(task.id, userName, 'claim', 'open', 'claimed', now);
      return { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id) };
    });

    const result = claimTx();
    if (result.error === 'not_found') return { reply: '❌ Task not found.', nextStep: 0, newData: {}, done: true };
    if (result.error === 'claimed') {
      const newList = db.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at DESC").all();
      return {
        reply: `❌ That task was just claimed by **${result.assignee}**.\n\n${formatTaskList(newList)}\n\nPick another? (enter \`#\` or id)`,
        nextStep: 1, newData: data, done: false,
      };
    }

    const full = { ...result.task, labels: JSON.parse(result.task.labels || '[]'), metadata: JSON.parse(result.task.metadata || '{}') };
    if (notifier) notifier.onClaimed(full).catch(() => {});
    return { reply: `✅ Claimed: **${result.task.title}**`, nextStep: 0, newData: {}, done: true };
  }

  return { reply: 'Something went wrong. Try `/qw task claim` again.', nextStep: 0, newData: {}, done: true };
}
