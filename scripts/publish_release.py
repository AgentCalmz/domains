#!/usr/bin/env python3
"""Publish the completed daily domain snapshot as a dated GitHub Release."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


API = "https://api.github.com"


def api_request(method: str, path: str, payload: dict | None = None) -> dict:
    token = os.environ["GITHUB_TOKEN"]
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "TeamPeach-DomainIntelligence",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    with urlopen(request, timeout=60) as response:
        body = response.read()
        return json.loads(body.decode("utf-8")) if body else {}


def get_release(repo: str, tag: str) -> dict | None:
    try:
        return api_request("GET", f"/repos/{repo}/releases/tags/{quote(tag, safe='')}")
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def upload_asset(upload_url: str, path: Path) -> dict:
    endpoint = upload_url.split("{", 1)[0]
    endpoint = endpoint + "?" + urlencode({"name": path.name})
    content_type = "application/json" if path.suffix == ".json" else "application/gzip"
    request = Request(
        endpoint,
        data=path.read_bytes(),
        method="POST",
        headers={
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "Content-Type": content_type,
            "User-Agent": "TeamPeach-DomainIntelligence",
        },
    )
    with urlopen(request, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    repo = os.getenv("GITHUB_REPOSITORY", "")
    token = os.getenv("GITHUB_TOKEN", "")
    if not repo or not token:
        print("GITHUB_REPOSITORY and GITHUB_TOKEN are required.", file=sys.stderr)
        return 1

    output_root = Path(os.getenv("OUTPUT_DIR", "output"))
    latest_path = output_root / "latest.json"
    if not latest_path.is_file():
        print("No completed snapshot found; refusing to publish.", file=sys.stderr)
        return 1

    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    date = latest["date"]
    tag = f"daily-{date}"
    snapshot_dir = output_root / "daily" / date
    if not snapshot_dir.is_dir() or not (snapshot_dir / "summary.json").is_file():
        print("Daily snapshot is incomplete; refusing to publish.", file=sys.stderr)
        return 1

    assets = sorted(path for path in snapshot_dir.iterdir() if path.is_file())
    assets.append(latest_path)
    if not assets:
        print("No snapshot files found.", file=sys.stderr)
        return 1

    body = (
        f"Daily TeamPeach domain data snapshot for {date}.\n\n"
        "Contains compressed, normalised domain-level feeds and a source/count summary.\n\n"
        "Sources: Webamon newly observed and removed domain feeds; WhoisFreaks free expired "
        "and dropped domain feeds. Each source remains separately identified.\n\n"
        "A Webamon zone-file observation is not a guaranteed registrar creation/removal date. "
        "Expired, dropped and removed records are not interchangeable, and a removed or "
        "dropped domain is not automatically available to register."
    )

    release = get_release(repo, tag)
    if release is None:
        release = api_request(
            "POST",
            f"/repos/{repo}/releases",
            {
                "tag_name": tag,
                "name": f"Daily domain data — {date}",
                "body": body,
                "draft": False,
                "prerelease": False,
                "make_latest": "true",
            },
        )
    else:
        for asset in release.get("assets", []):
            api_request("DELETE", f"/repos/{repo}/releases/assets/{asset['id']}")
        release = api_request(
            "PATCH",
            f"/repos/{repo}/releases/{release['id']}",
            {
                "name": f"Daily domain data — {date}",
                "body": body,
                "draft": False,
                "prerelease": False,
                "make_latest": "true",
            },
        )

    uploaded = []
    for path in assets:
        result = upload_asset(release["upload_url"], path)
        uploaded.append({"name": result["name"], "size": result["size"], "url": result["browser_download_url"]})

    expected = {path.name for path in assets}
    actual = {item["name"] for item in uploaded}
    if expected != actual:
        raise RuntimeError(f"Release asset verification failed. Expected {expected}, got {actual}")

    print(
        json.dumps(
            {
                "release": release.get("html_url"),
                "tag": tag,
                "date": date,
                "assets": uploaded,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
