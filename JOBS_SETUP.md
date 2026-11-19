# TeamPeach Jobs API — Cloudflare setup

This extends the existing TeamPeach domain Worker. It preserves all current domain endpoints and adds a D1-backed jobs API at the **same Worker hostname** already allowed by the TeamPeach website CSP:

`https://teampeach-domain-api.creatorletofficial.workers.dev`

## 1. Create D1

From this repository root:

```bash
npx wrangler@4 d1 create teampeach-jobs
```

Copy the database ID printed by Wrangler into `wrangler.toml`, replacing `REPLACE_WITH_TEAMPEACH_JOBS_D1_ID`.

## 2. Apply schema and configure Worker secret

```bash
npx wrangler@4 d1 migrations apply teampeach-jobs --remote
npx wrangler@4 secret put JOBS_INGEST_TOKEN
```

For `JOBS_INGEST_TOKEN`, use a long random value. The exact same value must be added to the separate GitHub Actions collector repository as the `CLOUDFLARE_INGEST_TOKEN` secret. Never put this token in TeamPeach frontend JavaScript.

## 3. Deploy the Worker

```bash
npx wrangler@4 deploy
```

This deploys the updated `teampeach-domain-api` Worker, keeping the existing hostname and domain-data endpoints intact. Confirm:

- `GET /v1/jobs/health` — checks the D1 binding
- `GET /v1/jobs/stats` — returns 30-day job metrics
- `GET /v1/jobs?days=30` — returns searchable job listings

## 4. Ingestion routes

All ingestion routes require `Authorization: Bearer <JOBS_INGEST_TOKEN>`:

- `GET /v1/ingest/boards` — returns the persistent ATS board registry
- `POST /v1/ingest/boards` — upserts newly verified employer boards
- `POST /v1/ingest/jobs` — upserts a batch of up to 250 postings
- `POST /v1/ingest/run` — records a collector run summary

The public `/v1/jobs` routes are read-only and do not require an account secret.

## Storage and freshness

The collector only submits jobs with a valid publication date inside the last 30 days. D1 preserves `first_seen_at` and refreshes `last_seen_at` separately. A posting that has not been seen in four days becomes `stale`; it is not declared closed based only on a feed outage. Records older than 45 days are removed during ingestion.

The Worker does not scrape employer websites or store full job descriptions. It stores listing metadata and original application links.
