#!/usr/bin/env python3
"""Upload one completed daily snapshot to Cloudflare R2 (S3-compatible)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import boto3


def main() -> int:
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        print("Missing R2 configuration: " + ", ".join(missing), file=sys.stderr)
        return 1

    output_root = Path(os.getenv("OUTPUT_DIR", "output"))
    latest_path = output_root / "latest.json"
    if not latest_path.is_file():
        print("No completed snapshot found; refusing to upload.", file=sys.stderr)
        return 1

    latest = json.loads(latest_path.read_text(encoding="utf-8"))
    date = latest["date"]
    snapshot_dir = output_root / "daily" / date
    if not snapshot_dir.is_dir() or not (snapshot_dir / "summary.json").is_file():
        print("Daily snapshot is incomplete; refusing to upload.", file=sys.stderr)
        return 1

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    bucket = os.environ["R2_BUCKET_NAME"]
    prefix = os.getenv("R2_PREFIX", "domain-intelligence").strip("/")
    uploaded = []

    for path in sorted(snapshot_dir.iterdir()):
        if not path.is_file():
            continue
        key = f"{prefix}/daily/{date}/{path.name}"
        content_type = "application/json" if path.suffix == ".json" else "application/gzip"
        with path.open("rb") as body:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=body,
                ContentType=content_type,
            )
        uploaded.append(key)

    latest_key = f"{prefix}/latest.json"
    client.put_object(
        Bucket=bucket,
        Key=latest_key,
        Body=json.dumps(latest, separators=(",", ":")).encode("utf-8"),
        ContentType="application/json",
        CacheControl="public, max-age=60",
    )

    print(json.dumps({"bucket": bucket, "uploaded": uploaded, "latest_key": latest_key}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
