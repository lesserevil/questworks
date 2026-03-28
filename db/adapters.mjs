export function saveAdapterConfig(db, { id, type, name, configEncrypted }) {
  db.prepare(
    'INSERT OR REPLACE INTO adapters_config (id, type, name, config_encrypted) VALUES (?, ?, ?, ?)'
  ).run(id, type, name, configEncrypted);
}

export function loadAdapterConfigs(db) {
  return db.prepare('SELECT * FROM adapters_config').all();
}

export function deleteAdapterConfig(db, id) {
  db.prepare('DELETE FROM adapters_config WHERE id = ?').run(id);
  db.prepare('DELETE FROM adapter_state WHERE adapter_id = ?').run(id);
}

export function getAdapterConfig(db, id) {
  return db.prepare('SELECT * FROM adapters_config WHERE id = ?').get(id);
}
