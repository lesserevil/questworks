/**
 * SQLite DB adapter — wraps better-sqlite3 with the shared async interface.
 *
 * Interface:
 *   db.query(sql, params)      → Promise<row[]>
 *   db.queryOne(sql, params)   → Promise<row|null>
 *   db.run(sql, params)        → Promise<{ changes, lastInsertRowid }>
 *   db.transaction(fn)         → Promise<result>  (fn receives this db)
 *   db.close()                 → void
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SqliteDb {
  /**
   * @param {string} dbPath - path to SQLite file, or ':memory:'
   */
  constructor(dbPath) {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this.backend = 'sqlite';
    this.dbPath = dbPath;
  }

  /**
   * Apply the SQLite schema (idempotent — all CREATE IF NOT EXISTS).
   */
  applySchema() {
    const schema = readFileSync(join(__dirname, 'schema.sqlite.sql'), 'utf8');
    this._db.exec(schema);
    // Migration: ensure created_at exists on conversations for pre-existing DBs
    try {
      this._db.exec(`ALTER TABLE conversations ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
    } catch {}
  }

  /**
   * Run a SELECT and return all rows.
   * Params are positional (?) — pass as an array.
   */
  async query(sql, params = []) {
    return this._db.prepare(sql).all(...params);
  }

  /**
   * Run a SELECT and return the first row, or null.
   */
  async queryOne(sql, params = []) {
    return this._db.prepare(sql).get(...params) ?? null;
  }

  /**
   * Run an INSERT / UPDATE / DELETE.
   * Returns { changes, lastInsertRowid }.
   */
  async run(sql, params = []) {
    const info = this._db.prepare(sql).run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  /**
   * Run fn(db) inside a transaction.
   *
   * better-sqlite3 transactions are synchronous, which means a truly async fn
   * cannot be rolled back atomically within the better-sqlite3 transaction API.
   * We use manual BEGIN/COMMIT/ROLLBACK to support async fn bodies.
   *
   * If fn throws (synchronously or asynchronously), the transaction is rolled back.
   */
  async transaction(fn) {
    this._db.prepare('BEGIN').run();
    try {
      const result = await fn(this);
      this._db.prepare('COMMIT').run();
      return result;
    } catch (err) {
      try { this._db.prepare('ROLLBACK').run(); } catch {}
      throw err;
    }
  }

  /**
   * Expose the raw better-sqlite3 instance for legacy callers during migration.
   * @deprecated Use the async interface instead.
   */
  get raw() {
    return this._db;
  }

  close() {
    this._db.close();
  }
}
