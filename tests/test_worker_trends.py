from pathlib import Path
import unittest


class WorkerTrendEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = (Path(__file__).resolve().parents[1] / "worker" / "index.js").read_text(encoding="utf-8")

    def test_trends_endpoint_is_exposed_for_supported_periods(self):
        self.assertIn('url.pathname === "/v1/trends"', self.worker)
        self.assertIn('[7, 14, 30].includes(requested)', self.worker)
        self.assertIn('loadTrendHistory(days)', self.worker)

    def test_history_uses_dated_daily_release_summaries(self):
        self.assertIn('/releases?per_page=100', self.worker)
        self.assertIn(r'daily-(\d{4}-\d{2}-\d{2})', self.worker)
        self.assertIn('summary.sources', self.worker)
        self.assertIn('by_tld', self.worker)
        self.assertIn('requested_days', self.worker)
        self.assertIn('available_days', self.worker)


    def test_latest_summary_falls_back_to_dated_releases(self):
        self.assertIn("async function listDatedReleases()", self.worker)
        self.assertIn("async function getLatestFromDatedReleases(pointerError)", self.worker)
        self.assertIn("return getLatestFromDatedReleases(error)", self.worker)
        self.assertIn("releases.slice(0, 5)", self.worker)

    def test_history_does_not_invent_missing_daily_counts(self):
        self.assertIn('history.filter(Boolean)', self.worker)
        self.assertIn('Missing dates are not interpolated', self.worker)



    def test_revival_feed_endpoint_exposes_only_the_three_lifecycle_sources(self):
        self.assertIn('url.pathname === "/v1/revival-domains"', self.worker)
        self.assertIn('expired: { key: "whoisfreaks_expired"', self.worker)
        self.assertIn('dropped: { key: "whoisfreaks_dropped"', self.worker)
        self.assertIn('removed: { key: "removed_domains"', self.worker)
        self.assertIn('X-Domain-Source', self.worker)
        self.assertIn('X-Snapshot-Date', self.worker)
        self.assertIn('X-Domain-Count', self.worker)

    def test_revival_feed_refuses_missing_or_invalid_source_data(self):
        self.assertIn('Choose one lifecycle source: expired, dropped or removed.', self.worker)
        self.assertIn('sourceSummary?.status !== "success"', self.worker)
        self.assertIn('This lifecycle dataset is not available in the latest published snapshot.', self.worker)


if __name__ == "__main__":
    unittest.main()
