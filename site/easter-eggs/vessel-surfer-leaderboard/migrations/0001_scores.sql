CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge TEXT NOT NULL,
  name TEXT NOT NULL,
  seconds REAL NOT NULL,
  bumps INTEGER NOT NULL,
  points INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_rank ON scores (challenge, points DESC, seconds ASC, id ASC);
CREATE INDEX IF NOT EXISTS scores_ip ON scores (ip_hash, created_at);
