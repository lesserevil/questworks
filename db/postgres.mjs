/**
 * PostgreSQL DB adapter — wraps the `postgres` package with the shared async interface.
 *
 * Interface:
 *   db.query(sql, params)      → Promise<row[]>
 *   db.queryOne(sql, params)   → Promise<row|null>
 *   db.run(sql, params)        → Promise<{ changes, lastInsertRowid }>
 *   db.transaction(fn)         → Promise<result>
 *   db.close()                 → Promise<void>
 *
 * SQL format: use ? placeholders (same as SQLite). This adapter converts
 * them to $1, $2, ... automatically before sending to Postgres.
 *
 * DSN masking: DATABASE_URL credentials are never logged. Only host+db are shown.
 */
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Extract a safe loggable label from a Postgres DSN (no credentials).
 * e.g. "postgres://user:pass@host:5432/db" → "postgres://***@host:5432/db"
 */
export function maskDsn(dsn) {
  try {
    const url = new URL(dsn);
    url.username = url.username ? '***' : '';
    url.password = '';
    return url.toString();
  } catch {
    return 'postgres://***';
  }
}

/**
 * Convert ? placeholders to $1, $2, ... for Postgres.
 * Only replaces unquoted ? — does not handle edge cases like ? inside string literals,
 * which QuestWorks SQL doesn't use.
 */
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export class PostgresDb {
  /**
   * @param {string} connectionString - Full Postgres DSN
   * @param {object} options - postgres() options (e.g. { max: 10 })
   */
  constructor(connectionString, options = {}) {
    const safeLabel = maskDsn(connectionString);
    console.log(`[db] Connecting to PostgreSQL at ${safeLabel}`);

    this._sql = postgres(connectionString, {
      max: options.max || 10,
      idle_timeout: options.idle_timeout || 20,
      connect_timeout: options.connect_timeout || 30,
      // Never log the connection string
      debug: false,
      onnotice: () => {},
    });

    this.backend = 'postgres';
    this._dsn = connectionString; // kept private, never logged
  }

  /**
   * Apply the Postgres schema (idempotent — all CREATE IF NOT EXISTS).
   */
  async applySchema() {
    const schema = readFileSync(join(__dirname, 'schema.postgres.sql'), 'utf8');
    // Split on semicolons to run each statement individually
    const statements = schema.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await this._sql.unsafe(stmt);
    }
  }

  /**
   * Run a SELECT and return all rows as plain objects.
   * Params are positional — pass as an array, ? placeholders converted to $N.
   */
  async query(sql, params = []) {
    const rows = await this._sql.unsafe(toPositional(sql), params);
    return rows.map(r => ({ ...r }));
  }

  /**
   * Run a SELECT and return the first row, or null.
   */
  async queryOne(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Run an INSERT / UPDATE / DELETE.
   * Returns { changes, lastInsertRowid } — normalised to match SQLite interface.
   */
  async run(sql, params = []) {
    const result = await this._sql.unsafe(toPositional(sql), params);
    return {
      changes: result.count ?? 0,
      lastInsertRowid: result[0]?.id ?? null,
    };
  }

  /**
   * Run fn(db) inside a Postgres transaction.
   * Rolls back automatically if fn throws.
   */
  async transaction(fn) {
    return this._sql.begin(async (txSql) => {
      // Create a scoped db instance that uses the transaction connection
      const txDb = new PostgresTxDb(txSql);
      return fn(txDb);
    });
  }

  async close() {
    await this._sql.end();
  }
}

/**
 * Scoped db instance passed to transaction callbacks — uses the tx connection.
 * Exposes the same interface as PostgresDb.
 */
class PostgresTxDb {
  constructor(sql) {
    this._sql = sql;
    this.backend = 'postgres';
  }

  async query(sql, params = []) {
    const rows = await this._sql.unsafe(toPositional(sql), params);
    return rows.map(r => ({ ...r }));
  }

  async queryOne(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows[0] ?? null;
  }

  async run(sql, params = []) {
    const result = await this._sql.unsafe(toPositional(sql), params);
    return {
      changes: result.count ?? 0,
      lastInsertRowid: result[0]?.id ?? null,
    };
  }

  async transaction(fn) {
    // Nested transaction → savepoint
    return this._sql.savepoint(async (spSql) => {
      return fn(new PostgresTxDb(spSql));
    });
  }
}
