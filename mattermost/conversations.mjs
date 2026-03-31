import { randomUUID } from 'crypto';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getActiveConversation(db, userId, channelId) {
  const conv = await db.queryOne(`
    SELECT * FROM conversations
    WHERE user_id = ? AND channel_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `, [userId, channelId]);

  if (!conv) return null;

  const age = Date.now() - new Date(conv.updated_at).getTime();
  if (age > TTL_MS) {
    await db.run('DELETE FROM conversations WHERE id = ?', [conv.id]);
    return null;
  }

  return {
    ...conv,
    data: typeof conv.data === 'string' ? JSON.parse(conv.data || '{}') : (conv.data ?? {}),
  };
}

export async function createConversation(db, userId, channelId, flow, initialData = {}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO conversations (id, user_id, channel_id, flow, step, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `, [id, userId, channelId, flow, JSON.stringify(initialData), now, now]);
  return { id, user_id: userId, channel_id: channelId, flow, step: 0, data: initialData };
}

export async function updateConversation(db, id, step, data) {
  await db.run(
    'UPDATE conversations SET step = ?, data = ?, updated_at = ? WHERE id = ?',
    [step, JSON.stringify(data), new Date().toISOString(), id]
  );
}

export async function deleteConversation(db, id) {
  await db.run('DELETE FROM conversations WHERE id = ?', [id]);
}

export async function cleanupExpiredConversations(db) {
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  await db.run('DELETE FROM conversations WHERE updated_at < ?', [cutoff]);
}
