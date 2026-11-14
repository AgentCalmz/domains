#!/usr/bin/env python3
"""Backfill name-based category counts into recent daily release summaries."""

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

sys.path.insert(0, os.path.dirname(__file__))
from collect_domains import count_domain_categories

API = "https://api.github.com"
USER_AGENT = "TeamPeach-DomainIntelligence/1.0"


def api_request(method: str, url: str, token: str, payload: bytes | None = None) -> dict | list:
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


def upload_summary(upload_url: str, payload: bytes, token: str) -> None:
    endpoint = upload_url.split("{", 1)[0] + "?" + urlencode({"name": "summary.json"})
    api_request("POST", endpoint, token, payload)


def main() -> int:
    repository = os.getenv("GITHUB_REPOSITORY", "AgentCalmz/domains")
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        print("GITHUB_TOKEN is required.", file=sys.stderr)
        return 1

    limit = max(1, min(100, int(os.getenv("CATEGORY_BACKFILL_LIMIT", "30"))))
    releases = api_request(
        "GET",
        f"{API}/repos/{repository}/releases?per_page=100",
        token,
    )
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
        assets = {asset.get("name"): asset for asset in release.get("assets", [])}
        summary_asset = assets.get("summary.json")
        feed_asset = assets.get("new_domains.txt.gz")
        upload_url = release.get("upload_url")
        if not summary_asset or not feed_asset or not upload_url:
            errors.append({"date": date, "error": "A required daily release asset is missing."})
            continue

        try:
            original_summary = download_public_asset(summary_asset["browser_download_url"])
            summary = json.loads(original_summary.decode("utf-8"))
            new_source = summary.get("sources", {}).get("new_domains", {})
            if new_source.get("by_category"):
                skipped.append(date)
                continue

            compressed_feed = download_public_asset(feed_asset["browser_download_url"])
            domain_count, by_category = count_feed_categories(compressed_feed)
            new_source["by_category"] = by_category
            new_source["category_method"] = (
                "Overlapping keyword signals from domain names; not verified website classifications."
            )
            summary["sources"]["new_domains"] = new_source
            updated_summary = (json.dumps(summary, indent=2, sort_keys=True) + "\n").encode("utf-8")

            # Replace only the JSON summary asset. If uploading the new summary
            # fails, restore the exact original bytes so the daily release stays usable.
            api_request(
                "DELETE",
                f"{API}/repos/{repository}/releases/assets/{summary_asset['id']}",
                token,
            )
            try:
                upload_summary(upload_url, updated_summary, token)
            except Exception:
                try:
                    upload_summary(upload_url, original_summary, token)
                except Exception as restore_error:
                    errors.append({
                        "date": date,
                        "error": "Summary upload and rollback both failed: " + str(restore_error)[:180],
                    })
                    continue
                raise

            updated.append({"date": date, "domains_scanned": domain_count, "categories": len(by_category)})
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, RuntimeError) as error:
            errors.append({"date": date, "error": str(error)[:240]})

    print(json.dumps({"updated": updated, "already_present": skipped, "errors": errors}, indent=2))
    # Category summaries are an optional analytics layer; a partial backfill
    # must never invalidate the primary domain-data publication.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
