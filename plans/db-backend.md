# Plan: Dual DB Backend (SQLite + PostgreSQL)

**Author:** Dr. Benton Quest  
**Status:** Draft — pending Race review  
**Feature:** Add PostgreSQL support alongside existing SQLite backend via a shared DB abstraction layer

---

## Background

QuestWorks currently uses `better-sqlite3` throughout `db/migrations.mjs` and `routes/`. The goal is to support PostgreSQL as an alternative backend — useful for production deployments that need concurrent writes, connection pooling, or managed DB services — while keeping SQLite as the default for local/development use.

No existing Postgres data to migrate. No production data in either backend yet. This is a greenfield dual-backend feature.

---

## Approach

Introduce a **db adapter layer** (`db/index.mjs`) that presents a single interface to the rest of the application. All SQL-executing modules (`db/migrations.mjs`, `routes/tasks.mjs`, `routes/adapters.mjs`, `sync/scheduler.mjs`, `mattermost/notify.mjs`) will import from `db/index.mjs` rather than instantiating `Database` directly.

Two implementations:
- `db/sqlite.mjs` — wraps `better-sqlite3` (existing behavior)
- `db/postgres.mjs` — wraps `postgres` (the `postgres` npm package, chosen for its clean async API and minimal footprint)

Backend is selected at startup via the `DATABASE_URL` environment variable:
- Not set or `sqlite://...` → SQLite
- `postgres://...` or `postgresql://...` → PostgreSQL

---

## Schema Changes

The existing `db/schema.sql` has two issues to fix during this work:

1. **Column name mismatch**: `adapters_config.config_json_encrypted` — the column name in schema differs from the column name referenced in application code (`config_encrypted`). Standardise on **`config_encrypted`** in both schema and code.
2. **Timestamp type**: SQLite stores timestamps as `TEXT`. PostgreSQL schema will use `TIMESTAMPTZ` for all timestamp columns (`created_at`, `updated_at`, `ts`, `claimed_at`, etc.) for proper ordering and timezone handling.
3. **Auto-increment**: `task_history.id INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY` in Postgres.
4. **JSON fields**: `labels`, `metadata`, `data` stored as `TEXT` (JSON strings) in SQLite → `JSONB` in Postgres for better query support.

Two separate schema files will be maintained:
- `db/schema.sqlite.sql` (rename of current `db/schema.sql`)
- `db/schema.postgres.sql` (new)

---

## DB Interface

`db/index.mjs` exports a single `getDb()` function that returns an initialized db client conforming to this interface:

```js
// All methods return Promises (even for SQLite, wrapped for consistency)
db.query(sql, params)      // → [rows]   SELECT
db.queryOne(sql, params)   // → row|null SELECT (first result)
db.run(sql, params)        // → { changes, lastInsertRowid }  INSERT/UPDATE/DELETE
db.transaction(fn)         // → result of fn(db)  atomic block
db.close()                 // graceful shutdown
```

SQLite sync methods are wrapped in Promise-returning shims. PostgreSQL uses `postgres` tagged-template-literal queries internally but exposes the same interface.

---

## Configuration

Backend selection is via environment variables only (consistent with existing pattern — no `config.yaml` changes needed):

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Full connection URL. `sqlite:///path/to/file.db`, `postgres://user:pass@host/db`, or omit for default SQLite path | unset → SQLite at `$QUESTWORKS_DB` |
| `QUESTWORKS_DB` | SQLite path (used when `DATABASE_URL` is unset or sqlite) | `./questworks.db` |

No new env vars needed for PostgreSQL beyond `DATABASE_URL`. Connection pool size and SSL options are derived from the URL query string (standard `postgres` package behaviour).

---

## File Structure

```
db/
  index.mjs              NEW — getDb(), backend selection
  sqlite.mjs             NEW — SQLite adapter (wraps better-sqlite3)
  postgres.mjs           NEW — PostgreSQL adapter (wraps postgres pkg)
  schema.sqlite.sql      RENAME from schema.sql
  schema.postgres.sql    NEW — Postgres-flavoured schema
  migrations.mjs         UPDATED — use db/index.mjs interface; run correct schema
```

All existing callers (`routes/`, `sync/`, `mattermost/`) will be updated to import from `db/index.mjs` and use the async interface.

---

## Dependencies

Add to `package.json`:
- `postgres` — PostgreSQL client (tagged template, zero dependencies)

No removal of `better-sqlite3` — it stays as the SQLite driver.

---

## Acceptance Criteria

- **AC-1**: `getDb()` returns a SQLite connection when `DATABASE_URL` is unset or `sqlite://`.
- **AC-2**: `getDb()` returns a Postgres connection when `DATABASE_URL` is `postgres://` or `postgresql://`.
- **AC-3**: All existing routes and scheduler work unchanged with SQLite backend after refactor.
- **AC-4**: All existing routes and scheduler work with Postgres backend (integration test using real Postgres or `pg-mem`).
- **AC-5**: Schema column name `config_encrypted` is consistent between schema files and all application code.
- **AC-6**: `db.transaction()` provides atomicity on both backends.
- **AC-7**: `initDb()` in `migrations.mjs` applies the correct schema file for the selected backend and is idempotent.
- **AC-8**: `npm test` (SQLite suite) continues to pass — 137/137.
- **AC-9**: No credentials or `DATABASE_URL` values logged at any level.
- **AC-10**: `GET /health` reports the active backend (`sqlite` or `postgres`) in its response.

---

## Test Plan

### Unit Tests (`tests/db/`)

| ID | Test | Backend |
|----|------|---------|
| T1 | `getDb()` returns SQLite adapter when `DATABASE_URL` unset | SQLite |
| T2 | `getDb()` returns Postgres adapter when `DATABASE_URL=postgres://...` | mock/stub |
| T3 | `db.query()` returns array of rows | SQLite in-memory |
| T4 | `db.queryOne()` returns null when no rows | SQLite in-memory |
| T5 | `db.run()` returns `{ changes }` on UPDATE | SQLite in-memory |
| T6 | `db.transaction()` rolls back on error | SQLite in-memory |
| T7 | `initDb()` with SQLite applies `schema.sqlite.sql` and is idempotent | SQLite in-memory |
| T8 | `config_encrypted` column exists (not `config_json_encrypted`) | SQLite in-memory |

### Integration Tests (`tests/db/postgres.test.mjs`) — optional, skip if no Postgres in CI

| ID | Test | Notes |
|----|------|-------|
| T9 | Full task lifecycle (insert, claim, complete) via Postgres adapter | Requires `TEST_POSTGRES_URL` env var; skipped if absent |
| T10 | `db.transaction()` provides atomicity under Postgres | Same guard |

### Regression

- T11: Full `npm test` (137/137) still passes after route refactor to async interface.

---

## Implementation Notes

- **SQLite WAL mode** and `foreign_keys = ON` pragmas must be preserved in `sqlite.mjs`.
- **Postgres pool**: default pool size 10; configurable via `DATABASE_URL` query param (`?max=5`).
- **Atomic claim**: existing `UPDATE tasks SET status='claimed' WHERE id=? AND status='open'` pattern works on both backends. Check `changes === 1` (SQLite) and `rowCount === 1` (Postgres) — the adapter layer normalises to `{ changes }`.
- **JSON handling**: SQLite stores JSON as TEXT — `JSON.stringify`/`JSON.parse` at the adapter boundary. Postgres `JSONB` columns return parsed objects — adapter must handle both transparently.
- **Migration strategy**: `initDb()` runs the full schema (`CREATE TABLE IF NOT EXISTS` / Postgres equivalent). No versioned migration framework needed at this stage — the app has never been in production.

---

## Out of Scope

- No ORM or query builder (raw SQL only, same as today).
- No MySQL/MariaDB support.
- No data migration tooling (no production data exists yet).
- No connection failover or read replicas.
