export async function getConfig(db, key, defaultValue = null) {
  const row = await db.queryOne('SELECT value FROM config WHERE key = ?', [key]);
  if (!row || row.value === null) return defaultValue;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export async function setConfig(db, key, value) {
  await db.run(
    'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)',
    [key, JSON.stringify(value)]
  );
}

export async function getAllConfig(db) {
  const rows = await db.query('SELECT key, value FROM config', []);
  const result = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
  }
  return result;
}
