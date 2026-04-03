export async function saveAdapterConfig(db, { id, type, name, configEncrypted }) {
  await db.run(
    'INSERT INTO adapters_config (id, type, name, config_encrypted, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type=EXCLUDED.type, name=EXCLUDED.name, config_encrypted=EXCLUDED.config_encrypted',
    [id, type, name, configEncrypted, new Date().toISOString()]
  );
}

export async function loadAdapterConfigs(db) {
  return db.query('SELECT * FROM adapters_config', []);
}

export async function deleteAdapterConfig(db, id) {
  await db.run('DELETE FROM adapters_config WHERE id = ?', [id]);
  await db.run('DELETE FROM adapter_state WHERE adapter_id = ?', [id]);
}

export async function getAdapterConfig(db, id) {
  return db.queryOne('SELECT * FROM adapters_config WHERE id = ?', [id]);
}
