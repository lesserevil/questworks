export function getConfig(db, key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (!row || row.value === null) return defaultValue;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setConfig(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(key, JSON.stringify(value));
}

export function getAllConfig(db) {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const result = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }
  return result;
}
