/**
 * Flow: /qw task block
 * Step 1 — Show user's in-progress tasks, ask which is blocked
 * Step 2 — Ask what's blocking it
 * Done  — Update status to blocked, notify #paperwork
 */

function formatList(tasks) {
  if (!tasks.length) return null;
  const lines = ['| # | ID | Title | Source |', '|---|---|---|---|'];
  tasks.forEach((t, i) => {
    const title = t.title.length > 45 ? t.title.slice(0, 42) + '...' : t.title;
    lines.push(`| ${i + 1} | \`${t.id.slice(0, 8)}\` | ${title} | ${t.source} |`);
  });
  return lines.join('\n');
}

export async function start(ctx, conv) {
  const { db } = ctx;
  const userName = conv.data.mm_user_name || 'unknown';
  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress','review') ORDER BY updated_at DESC"
  ).all(userName);
  if (!tasks.length) return { reply: 'You have no in-progress tasks.', done: true };
  return {
    reply: formatList(tasks) + '\n\nWhich task is blocked? (enter `#` or id)',
  };
}

export async function step(ctx, stepNum, message, data) {
  const { db, bot, notifier } = ctx;
  const userName = data.mm_user_name || 'unknown';
  const text = message.trim();

  if (stepNum === 1) {
    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress','review') ORDER BY updated_at DESC"
    ).all(userName);

    let taskId;
    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= tasks.length) {
      taskId = tasks[num - 1].id;
    } else {
      taskId = tasks.find(t => t.id === text || t.id.startsWith(text))?.id || null;
    }

    if (!taskId) {
      return { reply: "Couldn't find that task. Enter `#` or id:", nextStep: 1, newData: data, done: false };
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    return {
      reply: `**${task.title}**\nWhat's blocking it?`,
      nextStep: 2,
      newData: { ...data, taskId },
      done: false,
    };
  }

  if (stepNum === 2) {
    if (!text) {
      return { reply: "Please describe what's blocking this task:", nextStep: 2, newData: data, done: false };
    }

    const taskId = data.taskId;
    const now = new Date().toISOString();
    db.prepare(`UPDATE tasks SET status='blocked', updated_at=? WHERE id=?`).run(now, taskId);
    db.prepare(`INSERT INTO task_history (task_id, actor, action, old_value, new_value, note, ts) VALUES (?,?,?,?,?,?,?)`)
      .run(taskId, userName, 'block', null, 'blocked', text, now);

    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);

    // Notify in the notification channel via bot
    if (bot?.enabled) {
      notifier._getChannelId().then(channelId => {
        if (channelId) bot.post(channelId, `🚧 **${task.title}** is blocked\n> ${text}\n— @${userName}`);
      }).catch(() => {});
    }

    return {
      reply: `🚧 Marked as blocked: **${task.title}**\nReason: ${text}`,
      nextStep: 0, newData: {}, done: true,
    };
  }

  return { reply: 'Something went wrong. Try `/qw task block` again.', nextStep: 0, newData: {}, done: true };
}
