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
- `GET /v1/trends?days=30` — returns available dated snapshot counts and per-TLD breakdowns for 7, 14 or 30 day trend analysis
- `GET /v1/new-domains` — streams the latest compressed newly observed domain list for browser-side discovery; the Worker does not decompress or scan the full feed
- `GET /v1/site-check?domain=example.com` — performs a cached reachability check for domains in the latest new-domain feed, returning website status, page title/description and up to 8,000 characters of extracted visible homepage text (not raw HTML)
- `GET /v1/domain?domain=example.com` — exact domain lookup across the four feeds

The Worker reads public GitHub Release assets and caches the immutable index shards. The API does not scan full domain lists.

## Data interpretation

- A Webamon newly observed domain is not proof of its exact registrar creation date.
- Website status checks are requested by the browser for the 30 visible domains on the current page, with at most two checks running concurrently. Recent results are cached in the visitor browser and at the Worker for up to four hours; these checks are not part of the daily ingestion job.
- Website status checks are lightweight homepage reachability and content observations. The Worker reads at most the first 128 KiB of the homepage response, extracts a bounded plain-text sample, and excludes scripts/styles/navigation/footer markup. They do not crawl the rest of the site or confirm an operating business, ownership, security, legitimacy or demand. Parked-page classification is heuristic.
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
