const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS room (
     slug TEXT NOT NULL,
     title TEXT NOT NULL,
     pin TEXT NOT NULL,
     pin_version INTEGER NOT NULL DEFAULT 1,
     archived INTEGER NOT NULL DEFAULT 0,
     bytes_used INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS posts (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     text TEXT,
     file_name TEXT,
     file_size INTEGER,
     file_type TEXT,
     r2_key TEXT,
     author_name TEXT NOT NULL,
     author_role TEXT NOT NULL,
     author_session TEXT,
     author_email TEXT,
     created_at INTEGER NOT NULL,
     pinned INTEGER NOT NULL DEFAULT 0,
     pinned_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     pin_version INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rate_events (
     bucket TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rate_events_bucket_at ON rate_events (bucket, at)`,
];

/** Idempotent. Runs at construction and again after deleteAll(), which drops every table. */
export function migrate(sql: SqlStorage): void {
  for (const statement of STATEMENTS) sql.exec(statement);
}
