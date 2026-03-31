/**
 * db/migrations.mjs
 *
 * Provides initDb() for backward compatibility with existing code and tests.
 * New code should use getDb() from db/index.mjs instead.
 */
import { SqliteDb } from './sqlite.mjs';

/**
 * Initialize (or open) a SQLite database at dbPath.
 * Applies the schema and returns a SqliteDb instance.
 *
 * @param {string} dbPath
 * @returns {SqliteDb}
 */
export function initDb(dbPath) {
  const db = new SqliteDb(dbPath);
  db.applySchema();
  return db;
}
