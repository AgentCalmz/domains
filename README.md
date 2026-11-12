# TeamPeach Domain Intelligence Data

This repository runs the first-stage daily ingestion pipeline for the TeamPeach Domain Intelligence products.

## What it collects

- Webamon: newly observed domains and domains removed from the monitored zone-file data.
- WhoisFreaks: its public free expired and dropped domain lists, kept as separate secondary datasets.

The pipeline normalises domain names, removes duplicates within each source, writes compressed domain-level snapshots, and produces a small JSON summary. It does **not** replace the source datasets with counts.

## Schedule

Daily at 07:45 Africa/Lagos, plus a manual **Run workflow** option in GitHub Actions.

## Storage

Until Cloudflare R2 is configured, each run is retained as a GitHub Actions artifact for 7 days. Artifacts are temporary and are not the final persistent data store.

When R2 credentials are added as GitHub Actions secrets, the same run also writes immutable daily snapshots to R2 and updates `latest.json`.

Required R2 secrets:
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

## Data interpretation

- A Webamon newly observed domain is not proof of its exact registrar creation date.
- A Webamon removed domain is not proof that it expired or is currently available to register.
- WhoisFreaks expired and dropped feeds are distinct lifecycle signals. The free public GitHub dataset is a limited subset, not a complete global feed.

## Source and reuse notes

Sources: [Webamon](https://codeberg.org/webamon/newly_registered_domains) and [WhoisFreaks](https://github.com/WhoisFreaks/daily-expired-and-dropped-domains).

The source providers retain their respective rights and terms. This repository preserves source attribution and provenance. Before making raw third-party feed data available to customers or redistributing it, confirm that the applicable source terms permit the intended commercial use.

## Product roadmap

This shared data foundation supports:
1. Domain Intelligence Engine
2. Domain Trend Analyzer
3. Brand Protection Monitor
4. Domain Revival
5. Business Radar

AI is not used for routine collection, normalisation, filtering, deduplication or counting.
