PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS job_boards (
  ats TEXT NOT NULL CHECK (ats IN ('ashby','greenhouse','lever')),
  board_key TEXT NOT NULL,
  company TEXT NOT NULL,
  source_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_checked_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ats, board_key)
);

CREATE TABLE IF NOT EXISTS jobs (
  ats TEXT NOT NULL CHECK (ats IN ('ashby','greenhouse','lever')),
  board_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  employment_type TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  remote_status TEXT NOT NULL DEFAULT 'unspecified'
    CHECK (remote_status IN ('remote','hybrid','onsite','unspecified')),
  published_at TEXT NOT NULL,
  job_url TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  source_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','stale','closed')),
  PRIMARY KEY (ats, board_key, external_id),
  FOREIGN KEY (ats, board_key) REFERENCES job_boards(ats, board_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collected_at TEXT NOT NULL,
  boards_total INTEGER NOT NULL DEFAULT 0,
  boards_succeeded INTEGER NOT NULL DEFAULT 0,
  boards_with_errors INTEGER NOT NULL DEFAULT 0,
  jobs_sent INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 30
);

CREATE INDEX IF NOT EXISTS idx_jobs_published ON jobs(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_title ON jobs(title);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location);
CREATE INDEX IF NOT EXISTS idx_jobs_remote ON jobs(remote_status);
CREATE INDEX IF NOT EXISTS idx_jobs_status_seen ON jobs(status,last_seen_at);
CREATE INDEX IF NOT EXISTS idx_job_boards_active ON job_boards(active,ats);
