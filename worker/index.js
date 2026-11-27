const REPOSITORY = "AgentCalmz/domains";
const RELEASES_BASE = `https://github.com/${REPOSITORY}/releases/download`;
const LATEST_URL = `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`;

const SOURCE_FLAGS = [
  [1, "new_domains"],
  [2, "removed_domains"],
  [4, "whoisfreaks_expired"],
  [8, "whoisfreaks_dropped"],
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}


const JOB_ATS = new Set(["ashby", "greenhouse", "lever"]);
const JOB_BATCH_LIMIT = 250;
const JOB_RETENTION_DAYS = 45;
// Existing unchanged listings only refresh last_seen_at periodically. New or changed
// postings are still written immediately, while four-hour scans avoid rewriting every row.
// Keep the binding and D1 database ID in wrangler.toml as the deploy-time source of truth.
const JOB_LAST_SEEN_REFRESH_HOURS = 22;

function jobText(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function jobIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function jobAdmin(request, env) {
  const token = env.JOBS_INGEST_TOKEN;
  return !!token && request.headers.get("Authorization") === "Bearer " + token;
}

async function handleJobRoutes(request, url, env) {
  const now = new Date();
  const nowIso = now.toISOString();

  if (url.pathname === "/v1/jobs/health" && request.method === "GET") {
    if (!env.JOBS_DB) return json({ ok: false, service: "teampeach-jobs", error: "JOBS_DB binding is not configured." }, 503);
    const result = await env.JOBS_DB.prepare("SELECT COUNT(*) AS total FROM jobs").all();
    const meta = result.meta || {};
    return json({
      ok: true, service: "teampeach-jobs", database: "ready",
      total: Number(result.results?.[0]?.total || 0), window_days: 30,
      database_size_bytes: Number(meta.size_after || 0),
      rows_read: Number(meta.rows_read || 0),
      rows_written: Number(meta.rows_written || 0),
    }, 200, { "Cache-Control": "public, max-age=30, s-maxage=60" });
  }

  if (url.pathname === "/v1/jobs/stats" && request.method === "GET") {
    if (!env.JOBS_DB) return json({ ok: false, error: "Jobs database is not configured." }, 503);
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
    const [totals, newest, run] = await Promise.all([
      env.JOBS_DB.prepare("SELECT COUNT(*) AS jobs, COUNT(DISTINCT company) AS employers FROM jobs WHERE published_at >= ? AND status != 'closed'").bind(cutoff).first(),
      env.JOBS_DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE first_seen_at >= ?").bind(new Date(now.getTime() - 86400000).toISOString()).first(),
      env.JOBS_DB.prepare("SELECT id, collected_at, boards_total, boards_succeeded, boards_with_errors, jobs_sent, days FROM job_collection_runs ORDER BY id DESC LIMIT 1").first(),
    ]);
    return json({
      ok: true, database: "ready", window_days: 30,
      jobs: Number(totals?.jobs || 0),
      employers: Number(totals?.employers || 0),
      discovered_24h: Number(newest?.n || 0),
      latest_collection: run || null,
    }, 200, { "Cache-Control": "public, max-age=60, s-maxage=120" });
  }

  if (url.pathname === "/v1/jobs" && request.method === "GET") {
    if (!env.JOBS_DB) return json({ ok: false, error: "Jobs database is not configured." }, 503);
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days") || 30)));
    const page = Math.max(1, Math.min(10000, Number(url.searchParams.get("page") || 1)));
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
    const q = jobText(url.searchParams.get("q"), 100).toLowerCase();
    const location = jobText(url.searchParams.get("location") || url.searchParams.get("country"), 100).toLowerCase();
    const remote = jobText(url.searchParams.get("remote"), 20).toLowerCase();
    const type = jobText(url.searchParams.get("type"), 50).toLowerCase();
    const where = ["published_at >= ?", "status != 'closed'"];
    const params = [new Date(now.getTime() - days * 86400000).toISOString()];

    // Treat multi-word searches as terms, not one exact phrase. Every term must
    // occur in at least one searchable field, so "data analyst" also finds
    // "Analyst, Data" and "Lagos Nigeria" matches "Lagos, Nigeria".
    const queryTokens = q.split(/[\s,]+/).filter(Boolean).slice(0, 8);
    const ftsPhrase = (value) => '"' + String(value).replace(/"/g, '""') + '"';
    for (const token of queryTokens) {
      if (token.length >= 3) {
        where.push("jobs.rowid IN (SELECT rowid FROM jobs_search_fts WHERE jobs_search_fts MATCH ?)");
        params.push(ftsPhrase(token));
      } else {
        const pattern = "%" + token + "%";
        where.push("(lower(title) LIKE ? OR lower(company) LIKE ? OR lower(location) LIKE ? OR lower(department) LIKE ? OR lower(team) LIKE ?)");
        params.push(pattern, pattern, pattern, pattern, pattern);
      }
    }

    const locationTokens = location.split(/[\s,]+/).filter(Boolean).slice(0, 5);
    for (const token of locationTokens) {
      if (token.length >= 3) {
        where.push("jobs.rowid IN (SELECT rowid FROM jobs_search_fts WHERE jobs_search_fts MATCH ?)");
        params.push("location : " + ftsPhrase(token));
      } else {
        where.push("lower(location) LIKE ?");
        params.push("%" + token + "%");
      }
    }
    if (remote && remote !== "any") {
      where.push("remote_status = ?");
      params.push(remote);
    }
    if (type) {
      if (type.length >= 3) {
        where.push("jobs.rowid IN (SELECT rowid FROM jobs_search_fts WHERE jobs_search_fts MATCH ?)");
        params.push("employment_type : " + ftsPhrase(type));
      } else {
        where.push("lower(employment_type) LIKE ?");
        params.push("%" + type + "%");
      }
    }
    const clause = where.join(" AND ");
    const query = "SELECT ats, board_key, external_id, company, title, department, team, employment_type, location, remote_status, published_at, first_seen_at, last_seen_at, status, job_url, apply_url, source_url, COUNT(*) OVER() AS total_count FROM jobs WHERE " + clause + " ORDER BY published_at DESC, last_seen_at DESC LIMIT ? OFFSET ?";
    const result = await env.JOBS_DB.prepare(query).bind(...params, limit, (page - 1) * limit).all();
    const total = Number(result.results?.[0]?.total_count || 0);
    return json({
      ok: true,
      days,
      total,
      page,
      limit,
      has_more: page * limit < total,
      results: (result.results || []).map(({ total_count, ...job }) => job),
    }, 200, { "Cache-Control": "public, max-age=30, s-maxage=60" });
  }

  if (url.pathname.startsWith("/v1/ingest/")) {
    if (!jobAdmin(request, env)) return json({ ok: false, error: "Unauthorized job ingestion request." }, 401);
    if (!env.JOBS_DB) return json({ ok: false, error: "JOBS_DB binding is not configured." }, 503);

    if (url.pathname === "/v1/ingest/boards" && request.method === "GET") {
      const result = await env.JOBS_DB.prepare("SELECT ats, board_key, company, source_url FROM job_boards WHERE active = 1 ORDER BY ats, board_key").all();
      return json({ ok: true, boards: result.results || [] });
    }

    if (url.pathname === "/v1/ingest/boards" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
      const boards = Array.isArray(body?.boards) ? body.boards : [];
      if (!boards.length || boards.length > JOB_BATCH_LIMIT) return json({ ok: false, error: "Send between 1 and 250 boards per batch." }, 400);
      const statements = [];
      for (const board of boards) {
        const ats = jobText(board?.ats, 20).toLowerCase();
        const slug = jobText(board?.board_key, 100);
        const company = jobText(board?.company, 160);
        const sourceUrl = jobText(board?.source_url, 1200);
        if (!JOB_ATS.has(ats) || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,60}$/.test(slug) || !company || !sourceUrl.startsWith("https://")) continue;
        statements.push(env.JOBS_DB.prepare(
          "INSERT INTO job_boards(ats,board_key,company,source_url,first_seen_at,last_seen_at,last_checked_at,active) VALUES(?,?,?,?,?,?,?,1) " +
          "ON CONFLICT(ats,board_key) DO UPDATE SET company=excluded.company,source_url=excluded.source_url,last_seen_at=excluded.last_seen_at,active=1"
        ).bind(ats, slug, company, sourceUrl, nowIso, nowIso, nowIso));
      }
      for (let i = 0; i < statements.length; i += 80) await env.JOBS_DB.batch(statements.slice(i, i + 80));
      return json({ ok: true, received: boards.length, registered: statements.length });
    }

    if (url.pathname === "/v1/ingest/jobs" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
      const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
      if (!jobs.length || jobs.length > JOB_BATCH_LIMIT) return json({ ok: false, error: "Send between 1 and 250 jobs per batch." }, 400);
      const cutoff = now.getTime() - 30 * 86400000;
      const seenRefreshBefore = new Date(now.getTime() - JOB_LAST_SEEN_REFRESH_HOURS * 60 * 60 * 1000).toISOString();
      const statements = [];
      let rejected = 0;
      for (const item of jobs) {
        const ats = jobText(item?.ats, 20).toLowerCase();
        const slug = jobText(item?.board_key, 100);
        const externalId = jobText(item?.external_id, 160);
        const company = jobText(item?.company, 160);
        const title = jobText(item?.title, 240);
        const published = jobIso(item?.published_at);
        const jobUrl = jobText(item?.job_url, 1800);
        const applyUrl = jobText(item?.apply_url || item?.job_url, 1800);
        const sourceUrl = jobText(item?.source_url, 1200);
        const location = jobText(item?.location, 300);
        const remote = jobText(item?.remote_status || "unspecified", 20).toLowerCase();
        if (!JOB_ATS.has(ats) || !slug || !externalId || !company || !title || !published ||
            new Date(published).getTime() < cutoff || new Date(published).getTime() > now.getTime() + 86400000 ||
            !jobUrl.startsWith("https://") || !applyUrl.startsWith("https://") ||
            !sourceUrl.startsWith("https://") || !["remote", "hybrid", "onsite", "unspecified"].includes(remote)) {
          rejected++;
          continue;
        }
        statements.push(env.JOBS_DB.prepare(
          "INSERT INTO jobs(ats,board_key,external_id,company,title,department,team,employment_type,location,remote_status,published_at,job_url,apply_url,source_url,first_seen_at,last_seen_at,status) " +
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open') " +
          "ON CONFLICT(ats,board_key,external_id) DO UPDATE SET company=excluded.company,title=excluded.title,department=excluded.department,team=excluded.team,employment_type=excluded.employment_type,location=excluded.location,remote_status=excluded.remote_status,published_at=excluded.published_at,job_url=excluded.job_url,apply_url=excluded.apply_url,source_url=excluded.source_url,last_seen_at=excluded.last_seen_at,status='open' " +
          "WHERE jobs.company != excluded.company OR jobs.title != excluded.title OR jobs.department != excluded.department OR jobs.team != excluded.team OR jobs.employment_type != excluded.employment_type OR jobs.location != excluded.location OR jobs.remote_status != excluded.remote_status OR jobs.published_at != excluded.published_at OR jobs.job_url != excluded.job_url OR jobs.apply_url != excluded.apply_url OR jobs.source_url != excluded.source_url OR jobs.status != 'open' OR jobs.last_seen_at < ?"
        ).bind(ats, slug, externalId, company, title,
          jobText(item?.department, 120), jobText(item?.team, 120),
          jobText(item?.employment_type, 100), location, remote, published,
          jobUrl, applyUrl, sourceUrl, nowIso, nowIso, seenRefreshBefore));
      }
      for (let i = 0; i < statements.length; i += 80) await env.JOBS_DB.batch(statements.slice(i, i + 80));
      // Full-table maintenance is performed once at the end of the collection run.
      return json({ ok: true, accepted: statements.length, rejected, retention_days: JOB_RETENTION_DAYS });
    }

    if (url.pathname === "/v1/ingest/run" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
      // Run maintenance once after the collector has finished all posting batches.
      const staleBefore = new Date(now.getTime() - 4 * 86400000).toISOString();
      const retentionBefore = new Date(now.getTime() - JOB_RETENTION_DAYS * 86400000).toISOString();
      const stale = await env.JOBS_DB.prepare("UPDATE jobs SET status='stale' WHERE status='open' AND last_seen_at < ?").bind(staleBefore).run();
      const pruned = await env.JOBS_DB.prepare("DELETE FROM jobs WHERE published_at < ?").bind(retentionBefore).run();
      const saved = await env.JOBS_DB.prepare(
        "INSERT INTO job_collection_runs(collected_at,boards_total,boards_succeeded,boards_with_errors,jobs_sent,days) VALUES(?,?,?,?,?,?)"
      ).bind(jobIso(body?.collected_at) || nowIso,
        Math.max(0, Number(body?.boards_total) || 0),
        Math.max(0, Number(body?.boards_succeeded) || 0),
        Math.max(0, Number(body?.boards_with_errors) || 0),
        Math.max(0, Number(body?.jobs_sent) || 0), 30).run();
      return json({ ok: true, maintenance: { stale: Number(stale.meta?.changes || 0), pruned: Number(pruned.meta?.changes || 0) }, collection_recorded: Boolean(saved.success) });
    }

    return json({ ok: false, error: "Unknown ingestion endpoint or method." }, 404);
  }

  return null;
}

async function cachedFetch(url, ttlSeconds) {
  // Cache the GitHub asset subrequest at Cloudflare's edge. This works even
  // while the Worker is using its temporary workers.dev hostname.
  const upstream = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "TeamPeach-Domain-Intelligence/1.0" },
    cf: {
      cacheEverything: true,
      cacheTtl: ttlSeconds,
    },
  });

  if (!upstream.ok) {
    throw new Error(`Data source returned HTTP ${upstream.status}`);
  }

  return upstream;
}

async function getJson(url, ttlSeconds, ctx) {
  const response = await cachedFetch(url, ttlSeconds);
  return response.json();
}

async function listDatedReleases() {
  const releasesUrl = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
  const releasesResponse = await cachedFetch(releasesUrl, 1800);
  const releases = await releasesResponse.json();
  return (Array.isArray(releases) ? releases : [])
    .map((release) => {
      const match = String(release.tag_name || "").match(/^daily-(\d{4}-\d{2}-\d{2})$/);
      return match ? { date: match[1], tag: release.tag_name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function getLatestFromDatedReleases(pointerError) {
  const releases = await listDatedReleases();
  for (const release of releases.slice(0, 5)) {
    try {
      const summary = await getJson(`${RELEASES_BASE}/${release.tag}/summary.json`, 300);
      if (!summary.lookup_index || summary.lookup_index.bucket_count !== 256) continue;
      return {
        latest: { date: release.date, snapshot_prefix: `daily/${release.date}/` },
        summary,
        tag: release.tag,
      };
    } catch {
      // Try the next published daily release if the newest one is incomplete.
    }
  }
  throw new Error(
    pointerError && pointerError.message
      ? pointerError.message
      : "No valid dated domain snapshot is currently available.",
  );
}

async function getLatest(ctx) {
  try {
    const latest = await getJson(LATEST_URL, 180, ctx);
    if (!latest || !/^\d{4}-\d{2}-\d{2}$/.test(latest.date || "")) {
      throw new Error("The latest domain snapshot pointer is invalid.");
    }

    const tag = `daily-${latest.date}`;
    const summaryUrl = `${RELEASES_BASE}/${tag}/summary.json`;
    const summary = await getJson(summaryUrl, 300, ctx);

    if (!summary.lookup_index || summary.lookup_index.bucket_count !== 256) {
      throw new Error("The daily lookup index has not been published yet.");
    }

    return { latest, summary, tag };
  } catch (error) {
    // Domain discovery should survive a stale or temporarily unavailable
    // latest.json pointer by resolving the newest complete daily release.
    return getLatestFromDatedReleases(error);
  }
}

function normalizeDomain(input) {
  const raw = String(input || "").trim();
  if (!raw || raw.length > 253 || /[\s/:@?#%\\]/.test(raw)) {
    throw new Error("Enter a valid domain name, for example example.com.");
  }

  let hostname;
  try {
    const parsed = new URL(`https://${raw}`);
    if (parsed.pathname !== "/" || parsed.username || parsed.password || parsed.port) {
      throw new Error("Invalid domain format.");
    }
    hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new Error("Enter a valid domain name, for example example.com.");
  }

  const labels = hostname.split(".");
  const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    labels[labels.length - 1].length < 2 ||
    labels.some((label) => !labelPattern.test(label))
  ) {
    throw new Error("Enter a valid fully qualified domain name.");
  }

  return hostname;
}

async function getBucket(domain) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(domain),
  );
  const firstByte = new Uint8Array(digest)[0];
  return firstByte.toString(16).padStart(2, "0");
}

async function lookupDomain(domain, latest, ctx) {
  const bucket = await getBucket(domain);
  const indexUrl = `${RELEASES_BASE}/${latest.tag}/index-${bucket}.txt.gz`;
  const response = await cachedFetch(indexUrl, 86400);

  if (!response.body) {
    throw new Error("The lookup index is empty.");
  }

  const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  const rows = text.trimEnd() ? text.trimEnd().split("\n") : [];

  // Rows are sorted by domain, so one small shard can be searched with binary search.
  let low = 0;
  let high = rows.length - 1;
  let flags = 0;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const row = rows[middle];
    const separator = row.lastIndexOf("\t");
    if (separator < 0) {
      throw new Error("The lookup index contains an invalid row.");
    }

    const candidate = row.slice(0, separator);
    if (candidate === domain) {
      flags = Number(row.slice(separator + 1)) || 0;
      break;
    }

    if (candidate < domain) low = middle + 1;
    else high = middle - 1;
  }

  return {
    ok: true,
    domain,
    found: flags !== 0,
    snapshot_date: latest.latest.date,
    signals: SOURCE_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name),
    interpretation: {
      new_domains: "Observed in Webamon's newly observed zone-file feed; this is not a guaranteed registrar creation date.",
      removed_domains: "Observed in Webamon's removed zone-file feed; this does not prove expiry or current availability.",
      whoisfreaks_expired: "Included in WhoisFreaks' public expired-domain feed.",
      whoisfreaks_dropped: "Included in WhoisFreaks' public dropped-domain feed.",
    },
  };
}


function isSafePublicDomain(domain) {
  if (!domain || domain.length > 253) return false;
  if (domain === "localhost" || domain.endsWith(".localhost") ||
      domain.endsWith(".local") || domain.endsWith(".internal") ||
      domain.endsWith(".test") || domain.endsWith(".invalid")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain) || domain.includes(":")) return false;
  return domain.includes(".") && domain.split(".").every((label) => label.length > 0);
}

function isSameSiteHost(hostname, rootDomain) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === rootDomain || host === "www." + rootDomain ||
    (rootDomain.startsWith("www.") && host === rootDomain.slice(4));
}

async function readHtmlPrefix(response, maxBytes = 131072) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const part = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(part);
      total += part.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

function decodeHtmlText(value, maxLength = 8000) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, Number(maxLength) || 0));
}

function extractSiteMetadata(html) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]{0,1000}?)<\/title>/i);
  let description = "";
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (!/\bname\s*=\s*["']description["']/i.test(tag)) continue;
    const value = tag.match(/\bcontent\s*=\s*["']([^"']{0,2000})["']/i);
    if (value) description = decodeHtmlText(value[1], 1500);
    break;
  }

  // Return readable homepage copy, not scripts, styles, embedded frames or raw HTML.
  // This gives Premium research meaningful context while bounding request size.
  const visibleHtml = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/section|\/article|\/h[1-6])\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const pageContent = decodeHtmlText(visibleHtml, 8000);

  return {
    title: decodeHtmlText(titleMatch && titleMatch[1] || "", 300),
    description,
    text_excerpt: pageContent.slice(0, 900),
    page_content: pageContent,
    page_content_truncated: pageContent.length >= 8000 || String(html || "").length >= 131072,
  };
}
function parkedPageLikely(html, metadata) {
  const sample = (metadata.title + " " + metadata.description + " " +
    html.slice(0, 12000).replace(/<[^>]*>/g, " ")).toLowerCase();
  return /domain (name )?(is )?for sale|buy this domain|make an offer for (this )?domain|domain parking|parked free|parkingcrew|afternic|sedo\.com|hugedomains|dan\.com|this domain may be for sale|domain is available for purchase/.test(sample);
}

async function requestSitePage(domain, protocol) {
  let current = new URL(protocol + "//" + domain + "/");
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!["https:", "http:"].includes(current.protocol) ||
        current.username || current.password || current.port ||
        !isSafePublicDomain(current.hostname)) {
      return { status: "unreachable", status_label: "Unsafe or unsupported destination", http_status: null };
    }
    if (!isSameSiteHost(current.hostname, domain)) {
      return {
        status: "redirect",
        status_label: "Redirects to another domain",
        http_status: null,
        final_url: current.href.slice(0, 500),
      };
    }

    const response = await fetch(current.href, {
      method: "GET",
      redirect: "manual",
      headers: {
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Range": "bytes=0-131071",
        "User-Agent": "TeamPeach-Domain-Status/1.0 (+https://teampeach.org)",
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location) {
        return { status: "redirect", status_label: "Redirect response", http_status: response.status, final_url: current.href };
      }
      const target = new URL(location, current);
      if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.port ||
          !isSafePublicDomain(target.hostname)) {
        return { status: "redirect", status_label: "Redirects to an unsupported destination", http_status: response.status, final_url: target.href.slice(0, 500) };
      }
      if (!isSameSiteHost(target.hostname, domain)) {
        return { status: "redirect", status_label: "Redirects to another domain", http_status: response.status, final_url: target.href.slice(0, 500) };
      }
      current = target;
      continue;
    }

    const contentType = String(response.headers.get("Content-Type") || "").toLowerCase();
    const html = contentType.includes("text/html") || contentType.includes("xhtml")
      ? await readHtmlPrefix(response, 131072)
      : "";
    const metadata = extractSiteMetadata(html);
    const base = { http_status: response.status, final_url: current.href.slice(0, 500), content_type: contentType.slice(0, 100), ...metadata };

    if (parkedPageLikely(html, metadata)) {
      return { ...base, status: "possibly_parked", status_label: "Possibly parked or for sale" };
    }
    if (response.status >= 200 && response.status < 400) {
      return {
        ...base,
        status: protocol === "http:" ? "http_only" : "working",
        status_label: protocol === "http:" ? "Responds over HTTP only" : "Website responds",
      };
    }
    if ([401, 403, 407, 429].includes(response.status)) {
      return { ...base, status: "access_restricted", status_label: "Responds, but access is restricted" };
    }
    if ([404, 410].includes(response.status)) {
      return { ...base, status: "page_error", status_label: "Server responds, page not found" };
    }
    if (response.status >= 500) {
      return { ...base, status: "server_error", status_label: "Website server error" };
    }
    return { ...base, status: "unreachable", status_label: "No usable website response" };
  }
  return { status: "redirect", status_label: "Too many redirects", http_status: null };
}

async function checkSite(domain) {
  if (!isSafePublicDomain(domain)) {
    return { status: "unreachable", status_label: "Unsupported domain format", http_status: null };
  }
  let httpsError = null;
  try {
    const result = await requestSitePage(domain, "https:");
    if (result.status !== "unreachable" && result.status !== "server_error") return result;
    httpsError = result;
  } catch (error) {
    httpsError = error;
  }
  try {
    const httpResult = await requestSitePage(domain, "http:");
    if (httpResult.status !== "unreachable" && httpResult.status !== "server_error") return httpResult;
    return httpResult;
  } catch {
    return {
      status: "unreachable",
      status_label: "Website did not respond",
      http_status: httpsError && httpsError.http_status || null,
    };
  }
}

async function loadTrendHistory(days) {
  const dated = await listDatedReleases();

  // Anchor the lookback to the newest published snapshot, not the worker's
  // wall-clock date, so a delayed daily release does not create an empty chart.
  const newestDate = dated[0] && dated[0].date;
  const newestTimestamp = newestDate ? Date.parse(newestDate + "T00:00:00Z") : NaN;
  const cutoff = Number.isFinite(newestTimestamp)
    ? new Date(newestTimestamp - (days - 1) * 86400000).toISOString().slice(0, 10)
    : "";
  const selectedReleases = dated.filter((release) => !cutoff || release.date >= cutoff).slice(0, days);

  const history = await Promise.all(selectedReleases.map(async (release) => {
    try {
      const summaryUrl = `${RELEASES_BASE}/${release.tag}/summary.json`;
      const summary = await getJson(summaryUrl, 3600);
      const sources = summary.sources || {};
      const counts = summary.counts || {};
      return {
        date: release.date,
        status: summary.status || "unknown",
        counts: {
          new_domains: Number(counts.new_domains || 0),
          removed_domains: Number(counts.removed_domains || 0),
          whoisfreaks_expired: Number(counts.whoisfreaks_expired || 0),
          whoisfreaks_dropped: Number(counts.whoisfreaks_dropped || 0),
        },
        by_tld: {
          new_domains: sources.new_domains && sources.new_domains.by_tld || {},
          removed_domains: sources.removed_domains && sources.removed_domains.by_tld || {},
        },
        by_category: {
          new_domains: sources.new_domains && sources.new_domains.by_category || {},
        },
      };
    } catch {
      return null;
    }
  }));

  const validHistory = history.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  if (!validHistory.length) {
    throw new Error("No published daily trend summaries are available yet.");
  }

  return {
    ok: true,
    requested_days: days,
    available_days: validHistory.length,
    latest_date: validHistory[validHistory.length - 1].date,
    history: validHistory,
    note: "Trends use available daily snapshots. Category counts are overlapping domain-name keyword signals, not verified website categories. Missing dates are not interpolated, and source counts are observations rather than confirmed registrar events.",
  };
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const jobResponse = await handleJobRoutes(request, url, env);
  if (jobResponse) return jobResponse;

  if (request.method !== "GET") {
    return json({ ok: false, error: "Only GET requests are supported." }, 405);
  }

  if (url.pathname === "/") {
    return json({
      service: "TeamPeach Domain Intelligence API",
      version: "1.4",
      jobs_api_version: "1.0",
      status: "ready",
      endpoints: {
        health: "/v1/health",
        jobs_health: "/v1/jobs/health",
        jobs_search: "/v1/jobs?q=software&days=30",
        jobs_stats: "/v1/jobs/stats",
        latest: "/v1/latest",
        summary: "/v1/summary",
        trends: "/v1/trends?days=30",
        new_domains: "/v1/new-domains",
        revival_domains: "/v1/revival-domains?source=dropped",
        site_check: "/v1/site-check?domain=example.com",
        domain_lookup: "/v1/domain?domain=example.com",
      },
    });
  }

  if (url.pathname === "/v1/health") {
    return json({ ok: true, service: "teampeach-domain-api", status: "ready" });
  }

  if (url.pathname === "/v1/trends") {
    const requested = Number(url.searchParams.get("days") || 30);
    const days = [7, 14, 30].includes(requested) ? requested : 30;
    const result = await loadTrendHistory(days);
    return json(result, 200, { "Cache-Control": "public, max-age=1800, s-maxage=3600" });
  }

  if (url.pathname === "/v1/latest" || url.pathname === "/v1/summary") {
    const { latest, summary } = await getLatest(ctx);
    return json({
      ok: true,
      date: summary.date,
      fetched_at: summary.fetched_at,
      status: summary.status,
      counts: summary.counts,
      sources: summary.sources,
      lookup_index: summary.lookup_index,
      notes: summary.notes,
    }, 200, { "Cache-Control": "public, max-age=60" });
  }

  if (url.pathname === "/v1/new-domains") {
    const { latest, summary, tag } = await getLatest(ctx);
    if (summary.sources?.new_domains?.status !== "success") {
      throw new Error("The latest newly observed domain feed is not available.");
    }

    // Stream the immutable gzip asset directly. The Worker does not decompress
    // or scan the full feed, keeping CPU usage low.
    const assetUrl = `${RELEASES_BASE}/${tag}/new_domains.txt.gz`;
    const asset = await cachedFetch(assetUrl, 86400);
    if (!asset.body) {
      throw new Error("The latest newly observed domain feed is empty.");
    }

    const headers = new Headers({
      ...CORS_HEADERS,
      "Content-Type": "application/gzip",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Access-Control-Expose-Headers": "X-Snapshot-Date, X-Domain-Count",
      "X-Snapshot-Date": latest.date,
      "X-Domain-Count": String(summary.counts?.new_domains || 0),
    });
    const contentLength = asset.headers.get("Content-Length");
    if (contentLength) headers.set("Content-Length", contentLength);
    return new Response(asset.body, { status: 200, headers });
  }



  if (url.pathname === "/v1/revival-domains") {
    const source = String(url.searchParams.get("source") || "dropped").toLowerCase();
    const sourceConfig = {
      expired: { key: "whoisfreaks_expired", file: "whoisfreaks_expired.txt.gz" },
      dropped: { key: "whoisfreaks_dropped", file: "whoisfreaks_dropped.txt.gz" },
      removed: { key: "removed_domains", file: "removed_domains.txt.gz" },
    }[source];

    if (!sourceConfig) {
      return json({
        ok: false,
        error: "Choose one lifecycle source: expired, dropped or removed.",
      }, 400);
    }

    const { latest, summary, tag } = await getLatest(ctx);
    const sourceSummary = summary.sources?.[sourceConfig.key];
    if (sourceSummary?.status !== "success") {
      return json({
        ok: false,
        source,
        snapshot_date: latest.date,
        error: "This lifecycle dataset is not available in the latest published snapshot.",
        detail: sourceSummary?.error || "The source did not publish a usable dataset.",
      }, 503);
    }

    const assetUrl = `${RELEASES_BASE}/${tag}/${sourceConfig.file}`;
    const asset = await cachedFetch(assetUrl, 86400);
    if (!asset.body) {
      throw new Error("The selected lifecycle dataset is empty.");
    }

    const headers = new Headers({
      ...CORS_HEADERS,
      "Content-Type": "application/gzip",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Access-Control-Expose-Headers": "X-Snapshot-Date, X-Domain-Count, X-Domain-Source",
      "X-Snapshot-Date": latest.date,
      "X-Domain-Count": String(summary.counts?.[sourceConfig.key] || 0),
      "X-Domain-Source": source,
    });
    const contentLength = asset.headers.get("Content-Length");
    if (contentLength) headers.set("Content-Length", contentLength);
    return new Response(asset.body, { status: 200, headers });
  }

  if (url.pathname === "/v1/site-check") {
    let domain;
    try {
      domain = normalizeDomain(url.searchParams.get("domain"));
    } catch (error) {
      return json({ ok: false, error: error.message }, 400);
    }
    if (!isSafePublicDomain(domain)) {
      return json({ ok: false, error: "Only public domain names can be checked." }, 400);
    }

    const cacheKey = new Request(`${url.origin}/__cache/site-check?domain=${encodeURIComponent(domain)}`);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const latest = await getLatest(ctx);
    const indexed = await lookupDomain(domain, latest, ctx);
    if (!indexed.signals.includes("new_domains")) {
      return json({ ok: false, error: "Only domains in the latest newly observed feed can be checked here." }, 404);
    }

    const result = await checkSite(domain);
    const response = json({
      ok: true,
      domain,
      snapshot_date: latest.latest.date,
      checked_at: new Date().toISOString(),
      ...result,
      note: "This is a single automated reachability check, not a security scan or confirmation that an operating business exists.",
    }, 200, { "Cache-Control": "public, max-age=14400" });

    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
    return response;
  }

  if (url.pathname === "/v1/domain" || url.pathname === "/v1/lookup") {
    let domain;
    try {
      domain = normalizeDomain(url.searchParams.get("domain"));
    } catch (error) {
      return json({ ok: false, error: error.message }, 400);
    }

    const latest = await getLatest(ctx);
    const result = await lookupDomain(domain, latest, ctx);
    return json(result, 200, { "Cache-Control": "public, max-age=60" });
  }

  return json({ ok: false, error: "Endpoint not found." }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return json(
        {
          ok: false,
          error: "The domain data service could not complete the request.",
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        502,
      );
    }
  },
};
