import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function initDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Migrations for existing databases
  runMigrations(db);

  return db;
}

function runMigrations(db) {
  // Add created_at to conversations if missing (pre-existing DBs)
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
  } catch {}
}
