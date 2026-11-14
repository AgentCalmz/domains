#!/usr/bin/env python3
"""Backfill keyword-based category summaries into recent daily GitHub Releases."""

from __future__ import annotations

import gzip
import io
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from collect_domains import count_domain_categories

API = "https://api.github.com"
USER_AGENT = "TeamPeach-DomainIntelligence/1.0"


def api_request(method: str, url: str, payload: bytes | None = None) -> dict | list:
    token = os.environ["GITHUB_TOKEN"]
    request = Request(
        url,
        data=payload,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
            **({"Content-Type": "application/json"} if payload is not None else {}),
        },
    )
    with urlopen(request, timeout=90) as response:
        body = response.read()
        return json.loads(body.decode("utf-8")) if body else {}


def download_public_asset(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/octet-stream"})
    with urlopen(request, timeout=180) as response:
        return response.read()


def count_feed_categories(compressed: bytes) -> tuple[int, dict[str, int]]:
    domains: list[str] = []
    with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as source:
        for raw_line in source:
            domain = raw_line.decode("utf-8", errors="ignore").strip().lower()
            if domain and len(domain) <= 253 and "." in domain:
                domains.append(domain)
    return len(domains), count_domain_categories(domains)


def upload_category_asset(upload_url: str, payload: bytes) -> None:
    endpoint = upload_url.split("{", 1)[0] + "?" + urlencode({"name": "category-summary.json"})
    api_request("POST", endpoint, payload)


def main() -> int:
    repository = os.getenv("GITHUB_REPOSITORY", "AgentCalmz/domains")
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        print("GITHUB_TOKEN is required.", file=sys.stderr)
        return 1

    limit = max(1, min(100, int(os.getenv("CATEGORY_BACKFILL_LIMIT", "30"))))
    release_url = f"{API}/repos/{repository}/releases?per_page=100"
    releases = api_request("GET", release_url)
    if not isinstance(releases, list):
        raise RuntimeError("GitHub did not return a release list.")

    dated = []
    for release in releases:
        match = re.fullmatch(r"daily-(\d{4}-\d{2}-\d{2})", str(release.get("tag_name", "")))
        if match:
            dated.append((match.group(1), release))
    dated.sort(key=lambda item: item[0], reverse=True)

    updated = []
    skipped = []
    errors = []
    for date, release in dated[:limit]:
        assets = release.get("assets", [])
        asset_by_name = {asset.get("name"): asset for asset in assets}
        if "category-summary.json" in asset_by_name:
            skipped.append(date)
            continue

        feed_asset = asset_by_name.get("new_domains.txt.gz")
        upload_url = release.get("upload_url")
        if not feed_asset or not upload_url:
            errors.append({"date": date, "error": "Required release asset or upload URL is missing."})
            continue

        try:
            compressed = download_public_asset(feed_asset["browser_download_url"])
            domain_count, by_category = count_feed_categories(compressed)
            document = {
                "schema_version": 1,
                "date": date,
                "domain_count": domain_count,
                "method": "Overlapping keyword signals from domain names; not verified website classifications.",
                "by_category": by_category,
            }
            upload_category_asset(
                upload_url,
                (json.dumps(document, indent=2, sort_keys=True) + "\n").encode("utf-8"),
            )
            updated.append({"date": date, "domains_scanned": domain_count, "categories": len(by_category)})
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, RuntimeError) as error:
            errors.append({"date": date, "error": str(error)[:240]})

    print(json.dumps({"updated": updated, "already_present": skipped, "errors": errors}, indent=2))
    # Category summaries are an optional analytics layer; a partial backfill
    # must never fail or invalidate the primary daily domain-data publication.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
