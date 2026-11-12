import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from collect_domains import build_lookup_shards, normalize_domain, parse_domains


class DomainNormalizationTests(unittest.TestCase):
    def test_lowercases_and_removes_trailing_dot(self):
        self.assertEqual(normalize_domain(" Example.COM. "), "example.com")

    def test_accepts_idn_and_converts_to_punycode(self):
        self.assertEqual(normalize_domain("bücher.de"), "xn--bcher-kva.de")

    def test_removes_wildcard_prefix(self):
        self.assertEqual(normalize_domain("*.example.com"), "example.com")

    def test_rejects_invalid_values(self):
        for value in ("", "localhost", "not a domain", "127.0.0.1", "https://"):
            with self.subTest(value=value):
                self.assertIsNone(normalize_domain(value))

    def test_parses_and_deduplicates_plain_text_and_csv_lines(self):
        raw = b"Example.com\nexample.com\nfoo.org,extra\n# comment\ninvalid\n"
        domains, line_count, candidates = parse_domains(raw)
        self.assertEqual(domains, ["example.com", "foo.org"])
        self.assertEqual(line_count, 5)
        self.assertEqual(candidates, 4)

    def test_lookup_shards_combine_source_flags(self):
        source_sets = {
            "new_domains": ["example.com", "shared.net"],
            "removed_domains": ["shared.net"],
            "whoisfreaks_expired": ["expired.org"],
            "whoisfreaks_dropped": [],
        }
        shards, unique_count = build_lookup_shards(source_sets)
        self.assertEqual(len(shards), 256)
        self.assertEqual(unique_count, 3)

        def row_for(domain):
            bucket = hashlib.sha256(domain.encode("ascii")).digest()[0]
            prefix = domain + "\t"
            return next((row for row in shards[bucket] if row.startswith(prefix)), None)

        self.assertEqual(row_for("example.com"), "example.com\t1")
        self.assertEqual(row_for("shared.net"), "shared.net\t3")
        self.assertEqual(row_for("expired.org"), "expired.org\t4")


if __name__ == "__main__":
    unittest.main()
