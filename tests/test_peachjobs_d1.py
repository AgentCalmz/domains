import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKER = (ROOT / "worker" / "index.js").read_text(encoding="utf-8")
MIGRATION = (ROOT / "jobs" / "migrations" / "0002_jobs_search_fts.sql").read_text(encoding="utf-8")


class PeachJobsD1EfficiencyTests(unittest.TestCase):
    def test_search_uses_trigram_fts_for_substring_filters(self):
        self.assertIn("tokenize='trigram'", MIGRATION)
        self.assertIn("jobs_search_fts MATCH ?", WORKER)
        self.assertIn("location : ", WORKER)
        self.assertIn("employment_type : ", WORKER)
        self.assertIn("COUNT(*) OVER() AS total_count", WORKER)
        # The API no longer runs a separate COUNT query for each search.
        self.assertNotIn('prepare("SELECT COUNT(*) AS n FROM jobs WHERE " + clause)', WORKER)

    def test_fts_is_kept_in_sync_and_backfilled(self):
        self.assertIn("jobs_search_fts_ai AFTER INSERT ON jobs", MIGRATION)
        self.assertIn("jobs_search_fts_ad AFTER DELETE ON jobs", MIGRATION)
        self.assertIn("jobs_search_fts_au", MIGRATION)
        self.assertIn("VALUES('rebuild')", MIGRATION)

    def test_full_table_maintenance_runs_once_per_complete_collection(self):
        ingest_jobs = WORKER.index('if (url.pathname === "/v1/ingest/jobs"')
        ingest_run = WORKER.index('if (url.pathname === "/v1/ingest/run"')
        stale = WORKER.index("UPDATE jobs SET status='stale'")
        prune = WORKER.index("DELETE FROM jobs WHERE published_at < ?")
        self.assertLess(ingest_jobs, ingest_run)
        self.assertLess(ingest_run, stale)
        self.assertLess(ingest_run, prune)
        self.assertEqual(WORKER.count("UPDATE jobs SET status='stale'"), 1)
        self.assertEqual(WORKER.count("DELETE FROM jobs WHERE published_at < ?"), 1)
        self.assertNotIn("COALESCE(published_at,first_seen_at)", WORKER)

    def test_public_peachjobs_reads_have_short_http_cache_ttls(self):
        self.assertIn('Cache-Control": "public, max-age=30, s-maxage=60"', WORKER)
        self.assertIn('Cache-Control": "public, max-age=60, s-maxage=120"', WORKER)

    def test_daily_quota_errors_are_not_reported_as_generic_502(self):
        self.assertIn('"D1_DAILY_READ_LIMIT"', WORKER)
        self.assertIn('"D1_DAILY_WRITE_LIMIT"', WORKER)
        self.assertIn('"D1_STORAGE_LIMIT"', WORKER)
        self.assertIn('"Retry-After"', WORKER)
        self.assertIn("The saved job listings are safe", WORKER)

    def test_health_reports_size_and_query_row_metrics(self):
        self.assertIn("database_size_bytes", WORKER)
        self.assertIn("rows_read", WORKER)
        self.assertIn("rows_written", WORKER)


if __name__ == "__main__":
    unittest.main()
