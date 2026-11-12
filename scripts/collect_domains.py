#!/usr/bin/env python3
"""Fetch and validate daily domain feeds; write immutable compressed snapshots."""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import ipaddress
import json
import os
import re
import shutil
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

SOURCES = {
    "new_domains": {
        "url": os.getenv(
            "WEBAMON_NEW_URL",
            "https://codeberg.org/webamon/newly_registered_domains/raw/branch/main/new_domains.txt",
        ),
        "required": True,
        "minimum_domains": 100,
    },
    "removed_domains": {
        "url": os.getenv(
            "WEBAMON_REMOVED_URL",
            "https://codeberg.org/webamon/newly_registered_domains/raw/branch/main/removed_domains.txt",
        ),
        "required": True,
        "minimum_domains": 100,
    },
    "whoisfreaks_expired": {
        "url": os.getenv(
            "WHOISFREAKS_EXPIRED_URL",
            "https://raw.githubusercontent.com/WhoisFreaks/daily-expired-and-dropped-domains/main/0-latest-free-expired-domains.csv",
        ),
        "required": False,
        "minimum_domains": 10,
    },
    "whoisfreaks_dropped": {
        "url": os.getenv(
            "WHOISFREAKS_DROPPED_URL",
            "https://raw.githubusercontent.com/WhoisFreaks/daily-expired-and-dropped-domains/main/0-latest-free-dropped-domains.csv",
        ),
        "required": False,
        "minimum_domains": 10,
    },
}

MAX_DOWNLOAD_BYTES = 35 * 1024 * 1024
USER_AGENT = "TeamPeach-DomainIntelligence/0.1 (+https://teampeach.org)"


def normalize_domain(value: str) -> str | None:
    """Return a lowercase ASCII domain name, or None for invalid input."""
    value = value.strip().strip("\ufeff").strip().strip('"').strip("'")
    if not value or value.startswith(("#", ";")):
        return None

    if "://" in value:
        value = urlsplit(value).hostname or ""
    value = value.strip().lower().rstrip(".")
    if value.startswith("*."):
        value = value[2:]
    if value.startswith(".") or not value or "/" in value or ":" in value:
        return None

    try:
        ipaddress.ip_address(value)
        return None
    except ValueError:
        pass

    try:
        ascii_domain = value.encode("idna").decode("ascii")
    except UnicodeError:
        return None

    if len(ascii_domain) > 253 or "." not in ascii_domain:
        return None

    labels = ascii_domain.split(".")
    label_pattern = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    if any(not label_pattern.fullmatch(label) for label in labels):
        return None
    if len(labels[-1]) < 2:
        return None

    return ascii_domain


def parse_domains(data: bytes) -> tuple[list[str], int, int]:
    """Parse line-oriented domain or CSV feeds; return unique names and counts."""
    text = data.decode("utf-8-sig", errors="replace")
    line_count = len(text.splitlines())
    found: set[str] = set()
    candidates = 0

    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        candidate = row[0].strip()
        if candidate.lower() in {"domain", "domains", "domain_name", "hostname"}:
            continue
        candidates += 1
        domain = normalize_domain(candidate)
        if domain:
            found.add(domain)

    return sorted(found), line_count, candidates


def download(url: str) -> bytes:
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/plain,text/csv,application/octet-stream,*/*",
        },
    )
    last_error: Exception | None = None

    for attempt in range(3):
        try:
            with urlopen(request, timeout=90) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                data = response.read(MAX_DOWNLOAD_BYTES + 1)
            if len(data) > MAX_DOWNLOAD_BYTES:
                raise RuntimeError(f"Feed exceeds {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MB safety limit")
            if not data or len(data) < 100:
                raise RuntimeError("Feed is empty or unexpectedly small")
            prefix = data[:500].lstrip().lower()
            if prefix.startswith((b"<!doctype html", b"<html")):
                raise RuntimeError("Source returned an HTML page instead of a domain feed")
            return data
        except (HTTPError, URLError, TimeoutError, RuntimeError, OSError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(2 ** attempt)

    raise RuntimeError(f"Download failed: {last_error}")


def write_gzip(path: Path, domains: list[str]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = ("\n".join(domains) + "\n").encode("utf-8")
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            compressed.write(payload)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    output_root = Path(os.getenv("OUTPUT_DIR", "output"))
    if output_root.exists():
        shutil.rmtree(output_root)

    lagos_now = datetime.now(ZoneInfo("Africa/Lagos"))
    run_date = lagos_now.date().isoformat()
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    snapshot_dir = output_root / "daily" / run_date
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "schema_version": 1,
        "date": run_date,
        "timezone": "Africa/Lagos",
        "fetched_at": fetched_at,
        "status": "complete",
        "sources": {},
        "counts": {},
        "notes": [
            "Webamon new/removed records describe zone-file observations, not definitive registrar lifecycle dates.",
            "WhoisFreaks expired and dropped feeds are separate secondary signals.",
            "Feed counts are historical summaries; the domain-level files are the primary product data.",
        ],
    }

    required_failures: list[str] = []
    optional_failures: list[str] = []

    for key, config in SOURCES.items():
        record = {
            "url": config["url"],
            "required": config["required"],
            "status": "pending",
        }
        try:
            raw = download(config["url"])
            domains, line_count, candidates = parse_domains(raw)
            if len(domains) < config["minimum_domains"]:
                raise RuntimeError(
                    f"Only {len(domains)} valid unique domains; minimum expected is "
                    f"{config['minimum_domains']}"
                )

            filename = f"{key}.txt.gz"
            digest = write_gzip(snapshot_dir / filename, domains)
            record.update(
                {
                    "status": "success",
                    "bytes_downloaded": len(raw),
                    "source_lines": line_count,
                    "domain_candidates": candidates,
                    "unique_domains": len(domains),
                    "duplicates_and_invalid_removed": max(candidates - len(domains), 0),
                    "by_tld": dict(sorted(Counter(d.rsplit(".", 1)[-1] for d in domains).items())),
                    "output_file": filename,
                    "sha256": digest,
                }
            )
            summary["counts"][key] = len(domains)
        except Exception as exc:
            record.update({"status": "failed", "error": str(exc)})
            if config["required"]:
                required_failures.append(key)
            else:
                optional_failures.append(key)
        summary["sources"][key] = record

    if required_failures:
        print("Required source failure(s): " + ", ".join(required_failures), file=sys.stderr)
        print(json.dumps(summary, indent=2))
        return 1

    if optional_failures:
        summary["status"] = "partial"

    (snapshot_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    latest = {
        "schema_version": 1,
        "date": run_date,
        "status": summary["status"],
        "snapshot_prefix": f"daily/{run_date}/",
        "summary_file": f"daily/{run_date}/summary.json",
        "fetched_at": fetched_at,
    }
    (output_root / "latest.json").write_text(
        json.dumps(latest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
