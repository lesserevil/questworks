/**
 * Flow: /qw task done
 * Step 1 — Show user's claimed tasks, ask which is done
 * Step 2 — Optional completion note
 * Done  — Mark complete, sync to source, confirm
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
  const tasks = await db.query(
    "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress','review') ORDER BY updated_at DESC",
    [userName]
  );
  if (!tasks.length) return { reply: 'You have no claimed tasks to mark as done.', done: true };
  return {
    reply: formatList(tasks) + '\n\nWhich task did you complete? (enter `#` or id)',
  };
}

export async function step(ctx, stepNum, message, data) {
  const { db, notifier, adapters } = ctx;
  const userName = data.mm_user_name || 'unknown';
  const text = message.trim();

  if (stepNum === 1) {
    const tasks = await db.query(
      "SELECT * FROM tasks WHERE assignee=? AND status IN ('claimed','in_progress','review') ORDER BY updated_at DESC",
      [userName]
    );

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

    const task = await db.queryOne('SELECT * FROM tasks WHERE id=?', [taskId]);
    return {
      reply: `**${task.title}**\nOptional: add a completion note? (press Enter to skip)`,
      nextStep: 2,
      newData: { ...data, taskId },
      done: false,
    };
  }

  if (stepNum === 2) {
    const note = text || null;
    const taskId = data.taskId;
    const now = new Date().toISOString();

    await db.run("UPDATE tasks SET status='done', updated_at=? WHERE id=?", [now, taskId]);
    await db.run(
      "INSERT INTO task_history (task_id, actor, action, old_value, new_value, note, ts) VALUES (?,?,?,?,?,?,?)",
      [taskId, userName, 'complete', null, 'done', note, now]
    );

    const task = await db.queryOne('SELECT * FROM tasks WHERE id=?', [taskId]);
    const full = {
      ...task,
      labels: typeof task.labels === 'string' ? JSON.parse(task.labels || '[]') : (task.labels ?? []),
      metadata: typeof task.metadata === 'string' ? JSON.parse(task.metadata || '{}') : (task.metadata ?? {}),
    };

    const adapter = adapters?.get(task.source);
    if (adapter) adapter.close(full).catch(() => {});
    if (notifier) notifier.onCompleted(full).catch(() => {});

    return {
      reply: `✅ Marked as done: **${task.title}**${note ? `\nNote: ${note}` : ''}`,
      nextStep: 0, newData: {}, done: true,
    };
  }

  return { reply: 'Something went wrong. Try `/qw task done` again.', nextStep: 0, newData: {}, done: true };
}
