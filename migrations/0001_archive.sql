CREATE TABLE IF NOT EXISTS observations (
  day TEXT NOT NULL, stream TEXT NOT NULL, data TEXT NOT NULL,
  fetched_at TEXT NOT NULL, PRIMARY KEY(day, stream)
);
CREATE TABLE IF NOT EXISTS attempts (
  stream TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context (
  id TEXT PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, minutes INTEGER, intensity TEXT, notes TEXT
);
CREATE INDEX IF NOT EXISTS context_day ON context(day);
CREATE TABLE IF NOT EXISTS deliveries (
  week TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
