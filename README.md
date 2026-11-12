# TeamPeach Domain Intelligence Data

This repository runs the daily data ingestion pipeline for the TeamPeach Domain Intelligence products.

## Sources

- **Webamon**: primary feed for newly observed domains and domains removed from its monitored zone-file data.
- **WhoisFreaks**: secondary free feeds for expired and dropped domains. These remain separate signals.

## Daily workflow

GitHub Actions runs at **07:45 Africa/Lagos** and can also be started manually from the Actions tab.

Each run downloads the source files, validates and normalises domain names, removes duplicates within each source, compresses the domain-level files, and calculates historical summary counts by TLD. Counts supplement the data; they do not replace it.

## Permanent storage

Each successful daily run is published as a dated **GitHub Release** containing:
- Compressed newly observed domain names.
- Compressed Webamon removed domain names.
- Compressed WhoisFreaks expired and dropped domain names.
- A JSON summary with counts, TLD breakdowns, source URLs, checksums and fetch time.
- A small latest-snapshot pointer.

The release assets keep the daily data out of normal Git history. Re-running the workflow for the same Lagos calendar date replaces that date's release assets rather than creating duplicate daily releases.

## Data interpretation

- A Webamon newly observed domain is not proof of its exact registrar creation date.
- A Webamon removed domain is not proof that it expired or is currently available to register.
- WhoisFreaks expired and dropped feeds are distinct lifecycle signals. Its free public GitHub dataset is a limited subset, not a complete global feed.

## Sources and reuse

- [Webamon](https://codeberg.org/webamon/newly_registered_domains)
- [WhoisFreaks](https://github.com/WhoisFreaks/daily-expired-and-dropped-domains)

The source providers retain their respective rights and terms. This repository preserves source attribution and provenance. Before making raw third-party feed data available to customers or redistributing it, confirm that the applicable source terms permit the intended commercial use.

## Product roadmap

This shared data foundation supports:
1. Domain Intelligence Engine
2. Domain Trend Analyzer
3. Brand Protection Monitor
4. Domain Revival
5. Business Radar

AI is not used for routine collection, normalisation, filtering, deduplication or counting.
