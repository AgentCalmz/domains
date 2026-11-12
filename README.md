# TeamPeach Domain Intelligence Data

This repository runs the daily data ingestion pipeline for the TeamPeach Domain Intelligence products.

## Sources

- **Webamon**: primary feed for newly observed domains and domains removed from its monitored zone-file data.
- **WhoisFreaks**: secondary free feeds for expired and dropped domains. These remain separate signals.

## Daily workflow

GitHub Actions runs at **07:45 Africa/Lagos** and can also be started manually.

Each run downloads the source files, validates and normalises domain names, removes duplicates within each source, compresses the domain-level files, and calculates historical summary counts by TLD. Counts supplement the data; they do not replace it.

The workflow also creates a compact exact-lookup index: 256 SHA-256 buckets, with each domain mapped to a bitmask of the feeds in which it appeared. This lets the Cloudflare Worker fetch one small shard per lookup instead of downloading or scanning the full daily lists.

## Permanent storage

Each successful daily run is published as a dated **GitHub Release** containing:
- Compressed source-domain files.
- 256 compressed exact-lookup index shards.
- A JSON summary with counts, TLD breakdowns, source URLs, checksums and fetch time.
- A small latest-snapshot pointer.

Release assets keep daily data out of normal Git history. Re-running the workflow for the same Lagos calendar date replaces that date's release assets rather than creating duplicate daily releases.

## Cloudflare Worker API

The Worker code is in [worker/index.js](worker/index.js). It is a read-only API and requires no database or secrets.

Endpoints:
- `GET /` — API information
- `GET /v1/health` — health check
- `GET /v1/latest` — latest feed totals and TLD breakdowns
- `GET /v1/summary` — alias for latest summary
- `GET /v1/domain?domain=example.com` — exact domain lookup across the four feeds

The Worker reads public GitHub Release assets and caches the immutable index shards. The API does not scan full domain lists.

## Data interpretation

- A Webamon newly observed domain is not proof of its exact registrar creation date.
- A Webamon removed domain is not proof that it expired or is currently available to register.
- WhoisFreaks expired and dropped feeds are distinct lifecycle signals. Its free public GitHub dataset is a limited subset, not a complete global feed.

## Sources and reuse

- [Webamon](https://codeberg.org/webamon/newly_registered_domains)
- [WhoisFreaks](https://github.com/WhoisFreaks/daily-expired-and-dropped-domains)

The source providers retain their respective rights and terms. Before redistributing raw third-party feeds to customers, confirm that the applicable source terms permit the intended commercial use.

## Product roadmap

This shared data foundation supports:
1. Domain Intelligence Engine
2. Domain Trend Analyzer
3. Brand Protection Monitor
4. Domain Revival
5. Business Radar

AI is not used for routine collection, normalisation, filtering, deduplication or counting.
