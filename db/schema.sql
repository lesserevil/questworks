CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','claimed','in_progress','review','done','blocked')),
  assignee TEXT,
  claimed_at TEXT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_url TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  note TEXT,
  ts TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS adapter_state (
  adapter_id TEXT PRIMARY KEY,
  last_sync TEXT,
  last_error TEXT,
  task_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  flow TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS adapters_config (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  status TEXT DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_history(task_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_channel ON conversations(user_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
