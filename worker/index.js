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
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

async function getLatest(ctx) {
  const latest = await getJson(LATEST_URL, 180, ctx);
  if (!latest || !/^\d{4}-\d{2}-\d{2}$/.test(latest.date || "")) {
    throw new Error("The latest domain snapshot pointer is invalid.");
  }

  const tag = `daily-${latest.date}`;
  const summaryUrl = `${RELEASES_BASE}/${tag}/summary.json`;
  const summary = await getJson(summaryUrl, 300, ctx);

  if (!summary.lookup_index || summary.lookup_index.bucket_count !== 256) {
    throw new Error("The daily lookup index has not been published yet. Try again after the next successful ingestion run.");
  }

  return { latest, summary, tag };
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

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "GET") {
    return json({ ok: false, error: "Only GET requests are supported." }, 405);
  }

  if (url.pathname === "/") {
    return json({
      service: "TeamPeach Domain Intelligence API",
      version: "1.0",
      status: "ready",
      endpoints: {
        health: "/v1/health",
        latest: "/v1/latest",
        summary: "/v1/summary",
        new_domains: "/v1/new-domains",
        domain_lookup: "/v1/domain?domain=example.com",
      },
    });
  }

  if (url.pathname === "/v1/health") {
    return json({ ok: true, service: "teampeach-domain-api", status: "ready" });
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
