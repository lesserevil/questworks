/**
 * db/index.mjs — DB backend selector.
 *
 * Returns an initialized db instance based on DATABASE_URL:
 *   - Unset or sqlite://... → SqliteDb
 *   - postgres://... or postgresql://... → PostgresDb
 *
 * Usage:
 *   import { getDb } from './db/index.mjs';
 *   const db = await getDb();
 */
import { SqliteDb } from './sqlite.mjs';
import { PostgresDb } from './postgres.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _instance = null;

/**
 * Returns (and caches) the initialized db instance.
 * Call once at startup; subsequent calls return the same instance.
 *
 * @param {object} [options]
 * @param {string} [options.databaseUrl]   - Override DATABASE_URL (for testing)
 * @param {string} [options.questworksDb]  - Override QUESTWORKS_DB (for testing)
 * @param {boolean} [options.fresh]        - Force a new instance (for testing)
 * @returns {Promise<SqliteDb|PostgresDb>}
 */
export async function getDb({ databaseUrl, questworksDb, fresh = false } = {}) {
  if (_instance && !fresh) return _instance;

  const dbUrl = databaseUrl ?? process.env.DATABASE_URL;
  const isPostgres = dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'));

  if (isPostgres) {
    const db = new PostgresDb(dbUrl);
    await db.applySchema();
    _instance = db;
  } else {
    // SQLite path: resolve from DATABASE_URL (sqlite:///path) or QUESTWORKS_DB or default
    let dbPath;
    if (dbUrl && dbUrl.startsWith('sqlite://')) {
      dbPath = dbUrl.slice('sqlite://'.length);
    } else {
      dbPath = questworksDb ?? process.env.QUESTWORKS_DB ?? join(__dirname, '..', 'questworks.db');
    }
    const db = new SqliteDb(dbPath);
    db.applySchema();
    _instance = db;
  }

  return _instance;
}

/**
 * Clear the cached instance. Used in tests to get a fresh db per test.
 */
export function resetDb() {
  _instance = null;
}
