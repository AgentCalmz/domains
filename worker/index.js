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
  const releasesUrl = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
  const releasesResponse = await cachedFetch(releasesUrl, 1800);
  const releases = await releasesResponse.json();
  const dated = (Array.isArray(releases) ? releases : [])
    .map((release) => {
      const match = String(release.tag_name || "").match(/^daily-(\\d{4}-\\d{2}-\\d{2})$/);
      return match ? { date: match[1], tag: release.tag_name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, days);

  const history = await Promise.all(dated.map(async (release) => {
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
    note: "Trends are calculated from available daily source snapshots. Missing dates are not interpolated, and source counts are observations rather than confirmed registrar events.",
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
      version: "1.1",
      status: "ready",
      endpoints: {
        health: "/v1/health",
        latest: "/v1/latest",
        summary: "/v1/summary",
        trends: "/v1/trends?days=30",
        new_domains: "/v1/new-domains",
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
