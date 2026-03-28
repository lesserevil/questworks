import { randomUUID } from 'crypto';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getActiveConversation(db, userId, channelId) {
  const conv = db.prepare(`
    SELECT * FROM conversations
    WHERE user_id = ? AND channel_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(userId, channelId);

  if (!conv) return null;

  const age = Date.now() - new Date(conv.updated_at).getTime();
  if (age > TTL_MS) {
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    return null;
  }

  return { ...conv, data: JSON.parse(conv.data || '{}') };
}

export function createConversation(db, userId, channelId, flow, initialData = {}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversations (id, user_id, channel_id, flow, step, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).run(id, userId, channelId, flow, JSON.stringify(initialData), now, now);
  return { id, user_id: userId, channel_id: channelId, flow, step: 0, data: initialData };
}

export function updateConversation(db, id, step, data) {
  db.prepare('UPDATE conversations SET step = ?, data = ?, updated_at = ? WHERE id = ?')
    .run(step, JSON.stringify(data), new Date().toISOString(), id);
}

export function deleteConversation(db, id) {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

export function cleanupExpiredConversations(db) {
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  db.prepare('DELETE FROM conversations WHERE updated_at < ?').run(cutoff);
}
