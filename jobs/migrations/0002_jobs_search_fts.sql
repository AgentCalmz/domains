-- PeachJobs substring search index.
-- The external-content FTS table indexes only the fields used by public search.
-- Trigram matching preserves the existing contains/sub-string search behaviour.
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_search_fts USING fts5(
  title,
  company,
  location,
  department,
  team,
  employment_type,
  content='jobs',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS jobs_search_fts_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_search_fts(rowid,title,company,location,department,team,employment_type)
  VALUES(new.rowid,new.title,new.company,new.location,new.department,new.team,new.employment_type);
END;

CREATE TRIGGER IF NOT EXISTS jobs_search_fts_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_search_fts(jobs_search_fts,rowid,title,company,location,department,team,employment_type)
  VALUES('delete',old.rowid,old.title,old.company,old.location,old.department,old.team,old.employment_type);
END;

CREATE TRIGGER IF NOT EXISTS jobs_search_fts_au
AFTER UPDATE OF title,company,location,department,team,employment_type ON jobs BEGIN
  INSERT INTO jobs_search_fts(jobs_search_fts,rowid,title,company,location,department,team,employment_type)
  VALUES('delete',old.rowid,old.title,old.company,old.location,old.department,old.team,old.employment_type);
  INSERT INTO jobs_search_fts(rowid,title,company,location,department,team,employment_type)
  VALUES(new.rowid,new.title,new.company,new.location,new.department,new.team,new.employment_type);
END;

-- Build the search index for listings already in D1. Future changes are kept
-- in sync automatically by the triggers above.
INSERT INTO jobs_search_fts(jobs_search_fts) VALUES('rebuild');
