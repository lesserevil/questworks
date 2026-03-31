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
  const tasks = await db.query(
    "SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at DESC",
    []
  );
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
    const tasks = await db.query(
      "SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at DESC",
      []
    );

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

    const now = new Date().toISOString();
    const claimResult = await db.run(
      "UPDATE tasks SET status='claimed', assignee=?, claimed_at=?, updated_at=? WHERE id=? AND status='open'",
      [userName, now, now, taskId]
    );

    if (claimResult.changes === 0) {
      const newList = await db.query("SELECT * FROM tasks WHERE status='open' ORDER BY priority DESC, created_at DESC", []);
      return {
        reply: `❌ That task was just claimed by someone else.\n\n${formatTaskList(newList)}\n\nPick another? (enter \`#\` or id)`,
        nextStep: 1, newData: data, done: false,
      };
    }

    await db.run(
      "INSERT INTO task_history (task_id, actor, action, old_value, new_value, ts) VALUES (?,?,?,?,?,?)",
      [taskId, userName, 'claim', 'open', 'claimed', now]
    );

    const task = await db.queryOne('SELECT * FROM tasks WHERE id=?', [taskId]);
    const full = {
      ...task,
      labels: typeof task.labels === 'string' ? JSON.parse(task.labels || '[]') : (task.labels ?? []),
      metadata: typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata ?? {}),
    };
    if (notifier) notifier.onClaimed(full).catch(() => {});
    return { reply: `✅ Claimed: **${task.title}**`, nextStep: 0, newData: {}, done: true };
  }

  return { reply: 'Something went wrong. Try `/qw task claim` again.', nextStep: 0, newData: {}, done: true };
}
