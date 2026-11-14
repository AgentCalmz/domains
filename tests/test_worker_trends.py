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
        self.assertIn('daily-(\\\\d{4}-\\\\d{2}-\\\\d{2})', self.worker)
        self.assertIn('summary.sources', self.worker)
        self.assertIn('by_tld', self.worker)
        self.assertIn('requested_days', self.worker)
        self.assertIn('available_days', self.worker)

    def test_history_does_not_invent_missing_daily_counts(self):
        self.assertIn('validHistory.filter(Boolean)', self.worker)
        self.assertIn('Missing dates are not interpolated', self.worker)


if __name__ == "__main__":
    unittest.main()
