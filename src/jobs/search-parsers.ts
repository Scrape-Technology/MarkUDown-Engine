import * as cheerio from "cheerio";
import { fetch } from "undici";
import { EgressPolicyError, proxyAgentFor } from "../utils/egress.js";

/**
 * Pure (no network) SERP parsing + block detection for the `search` job.
 * Kept separate from search.ts so it can be unit-tested against saved HTML.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  markdown?: string;
  html?: string;
  /**
   * True when `url` was reconstructed from the visible breadcrumb (<cite>)
   * because Google's opaque `/goto?url=` redirect could not be resolved.
   * Absent for exact URLs.
   */
  url_approximate?: boolean;
  /**
   * Structured data read on the platform itself (platform engines only: americanas, kwai,
   * tiktok, facebook). Absent when the platform page could not be read — the SERP fields stay.
   */
  details?: PlatformDetails;
}

/** What a takedown request needs: who sells/posts it, for how much, when. Every field optional. */
export interface PlatformDetails {
  price?: number;
  currency?: string;
  /** Marketplace seller (3P store) of the best in-stock offer. */
  seller?: string;
  seller_id?: string;
  /** Every in-stock offer when more than one seller lists the product. */
  offers?: { seller: string; seller_id?: string; price: number }[];
  brand?: string;
  available?: boolean;
  /** Account behind a post/video/page (social platforms). */
  author?: string;
  author_handle?: string;
  author_url?: string;
  /** e.g. "15 mi seguidores" (Facebook) or a count (TikTok). */
  followers?: string | number;
  category?: string;
  /** External website a page links to (fake-store domains). */
  website?: string;
  /** Caption / description / transcript excerpt. */
  text?: string;
  published_at?: string;
  is_ad?: boolean;
  /** TikTok e-commerce (Shop) video. */
  is_shop_video?: boolean;
  stats?: Record<string, number>;
}

/** A parsed SERP entry. Exactly one of `url` / `gotoPath` is meaningful. */
export interface RawGoogleResult {
  title: string;
  snippet: string;
  /** Absolute, exact URL (JS markup, or `/url?q=` decoded). Empty when pending. */
  url: string;
  /** Relative `/goto?url=<opaque token>` link that still needs a redirect lookup. */
  gotoPath?: string;
  /** Best-effort URL rebuilt from the "https://host › a › b" breadcrumb. */
  citeUrl?: string;
}

export type EngineStatus = "ok" | "no_results" | "blocked" | "unparsed" | "error";

const GOOGLE_HOST_RE = /(^|\.)google\.[a-z.]+$/i;

function isGoogleHost(host: string): boolean {
  return GOOGLE_HOST_RE.test(host) || host === "gstatic.com" || host.endsWith(".gstatic.com");
}

/**
 * Turn an href found in a Google SERP into either an exact absolute URL or a
 * pending `/goto` path. Returns null for internal Google links (/search?,
 * /preferences, accounts.google.com, cache links ...).
 */
export function classifyGoogleHref(
  href: string,
): { url: string; gotoPath?: undefined } | { url?: undefined; gotoPath: string } | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return null;

  let u: URL;
  try {
    u = new URL(raw, "https://www.google.com");
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  if (isGoogleHost(u.hostname)) {
    // Only relative links or google.com links reach here.
    if (u.pathname === "/goto") {
      return u.searchParams.get("url") ? { gotoPath: `${u.pathname}${u.search}` } : null;
    }
    if (u.pathname === "/url") {
      // Classic redirect wrapper: /url?q=<real url>&sa=... (or ?url=<real url>).
      const target = u.searchParams.get("q") ?? u.searchParams.get("url");
      if (target && /^https?:\/\//i.test(target)) {
        try {
          const t = new URL(target);
          return isGoogleHost(t.hostname) ? null : { url: target };
        } catch {
          return null;
        }
      }
      return null;
    }
    return null; // /search?, /preferences, /advanced_search, /travel, ...
  }
  return { url: /^https?:\/\//i.test(raw) ? raw : u.toString() };
}

/** "https://www.tiktok.com › @user › video › 123" -> "https://www.tiktok.com/@user/video/123" */
export function citeToUrl(cite: string): string | undefined {
  const text = cite.replace(/ /g, " ").trim();
  if (!/^https?:\/\//i.test(text)) return undefined;
  // A truncated breadcrumb ("… › …") cannot be trusted.
  if (text.includes("…") || text.includes("...")) return undefined;
  const parts = text.split("›").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  try {
    const base = new URL(parts[0]);
    const path = parts.slice(1).map((p) => encodeURI(p.replace(/\s+/g, "-"))).join("/");
    return path ? `${base.origin}/${path}` : base.origin;
  } catch {
    return undefined;
  }
}

const AD_SELECTOR = "#tads, #tadsb, #bottomads, [data-text-ad], .ads-ad, .uEierd";
const SNIPPET_SELECTOR = ".VwiC3b, [data-sncf], .lEBKkf, .st";
const BOX_SELECTOR = "div.g, .MjjYud, .tF2Cxc, div[data-hveid]";

/**
 * Parse organic results from a Google SERP. Tolerates:
 *  - the JS markup (`div.g` > a > h3),
 *  - the "classic"/basic markup (`/url?q=<real>&sa=...` links),
 *  - the no-JS markup served on `/httpservice/retry/enablejs` (opaque relative
 *    `/goto?url=<token>` links, no `div.g`).
 * Results whose link is still an opaque `/goto` token come back with `gotoPath`
 * set and an empty `url`; resolve them with resolveGotoLinks().
 */
export function parseGoogleSerp(html: string, limit: number): RawGoogleResult[] {
  const $ = cheerio.load(html);
  const out: RawGoogleResult[] = [];
  const seen = new Set<string>();

  const push = (title: string, snippet: string, c: NonNullable<ReturnType<typeof classifyGoogleHref>>, cite?: string) => {
    if (out.length >= limit || !title) return;
    const key = c.url ?? c.gotoPath!;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(
      c.url !== undefined
        ? { title, snippet, url: c.url }
        : { title, snippet, url: "", gotoPath: c.gotoPath, citeUrl: cite ? citeToUrl(cite) : undefined },
    );
  };

  // Strategy 1 (any markup): every link that wraps an <h3> is a result title.
  $("a[href]:has(h3)").each((_, el) => {
    if (out.length >= limit) return;
    const $a = $(el);
    if ($a.closest(AD_SELECTOR).length) return;
    const c = classifyGoogleHref($a.attr("href") ?? "");
    if (!c) return;
    const title = $a.find("h3").first().text().replace(/\s+/g, " ").trim();

    // Snippet: only trust the enclosing block if it holds a single result
    // (video carousels put many results in one .MjjYud).
    let snippet = "";
    const $box = $a.closest(BOX_SELECTOR);
    if ($box.length && $box.find("a[href]:has(h3)").length === 1) {
      snippet = $box.find(SNIPPET_SELECTOR).first().text().replace(/\s+/g, " ").trim();
    }
    const cite = $a.find("cite").first().text() || $a.closest(BOX_SELECTOR).find("cite").first().text();
    push(title, snippet, c, cite);
  });

  // Strategy 2 (legacy JS layout): <h3> is a sibling of the <a>, not inside it.
  if (out.length < limit) {
    $("div.g").each((_, el) => {
      if (out.length >= limit) return;
      const $el = $(el);
      if ($el.closest(AD_SELECTOR).length) return;
      const title = $el.find("h3").first().text().replace(/\s+/g, " ").trim();
      const c = classifyGoogleHref($el.find("a[href]").first().attr("href") ?? "");
      if (!c) return;
      const snippet = $el.find(SNIPPET_SELECTOR).first().text().replace(/\s+/g, " ").trim();
      push(title, snippet, c, $el.find("cite").first().text());
    });
  }

  return out;
}

/**
 * Synchronous convenience wrapper: only results whose real URL is available
 * without any extra request (JS markup, `/url?q=`). Opaque `/goto` results are
 * skipped — use parseGoogleSerp() + resolveGotoLinks() to keep them.
 */
export function parseGoogleResults(html: string, limit: number): SearchResult[] {
  return parseGoogleSerp(html, limit * 2)
    .filter((r) => r.url)
    .slice(0, limit)
    .map(({ title, url, snippet }) => ({ title, url, snippet }));
}

export type LocationFetcher = (gotoUrl: string, timeoutMs: number) => Promise<string | null>;

/**
 * Default resolver: one manual-redirect request, reads the `location` header.
 * This is a request to a TARGET (google.*), so it MUST leave through the dedicated sticky
 * Google Geonode proxy — proxyAgentFor() throws EgressPolicyError when none is configured,
 * and never lets it fall back to this host's own IP (egress rule, src/utils/egress.ts).
 */
export const fetchGotoLocation: LocationFetcher = async (gotoUrl, timeoutMs) => {
  const res = await fetch(gotoUrl, {
    dispatcher: proxyAgentFor(gotoUrl),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "Mozilla/5.0 (compatible; MarkUDown-Engine)" },
  });
  return res.headers.get("location");
};

/**
 * Resolve pending `/goto?url=` links to their real destination with a small
 * concurrency limit and a short per-request timeout. On failure falls back to
 * the breadcrumb-derived URL (flagged `url_approximate`), or drops the result
 * when neither is available. Never throws — except EgressPolicyError (no proxy configured),
 * which must surface instead of silently degrading to breadcrumb URLs.
 */
export async function resolveGotoLinks(
  raw: RawGoogleResult[],
  limit: number,
  opts: { concurrency?: number; timeoutMs?: number; fetcher?: LocationFetcher; origin?: string } = {},
): Promise<{ results: SearchResult[]; resolved: number; approximated: number; dropped: number }> {
  const { concurrency = 5, timeoutMs = 4000, fetcher = fetchGotoLocation, origin = "https://www.google.com" } = opts;
  const candidates = raw.slice(0, limit);
  const slots: (SearchResult | null)[] = new Array(candidates.length).fill(null);
  let resolved = 0;
  let approximated = 0;
  let cursor = 0;

  const work = async () => {
    while (cursor < candidates.length) {
      const i = cursor++;
      const r = candidates[i];
      if (!r.gotoPath) {
        slots[i] = { title: r.title, url: r.url, snippet: r.snippet };
        continue;
      }
      let real: string | null = null;
      try {
        const loc = await fetcher(`${origin}${r.gotoPath}`, timeoutMs);
        if (loc && /^https?:\/\//i.test(loc) && !isGoogleHost(new URL(loc).hostname)) real = loc;
      } catch (err) {
        if (err instanceof EgressPolicyError) throw err; // policy violation: never degrade silently
        real = null;
      }
      if (real) {
        resolved++;
        slots[i] = { title: r.title, url: real, snippet: r.snippet };
      } else if (r.citeUrl) {
        approximated++;
        slots[i] = { title: r.title, url: r.citeUrl, snippet: r.snippet, url_approximate: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, work));

  // Dedupe on the final URL (two tokens can point to the same page).
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const s of slots) {
    if (s && !seen.has(s.url)) {
      seen.add(s.url);
      results.push(s);
    }
  }
  return { results, resolved, approximated, dropped: candidates.length - slots.filter(Boolean).length };
}

// ---------------------------------------------------------------------------
// Block / empty-page detection
// ---------------------------------------------------------------------------

const GOOGLE_BLOCK_RE =
  /id="captcha-form"|g-recaptcha|\/sorry\/index|unusual traffic|tráfego incomum|trafego incomum|nossos sistemas detectaram|our systems have detected|automated queries|consulta automática|detectamos tráfego/i;
const GOOGLE_NO_RESULTS_RE =
  /did not match any documents|n[ãa]o encontrou nenhum documento|nenhum resultado (foi )?encontrado|no results found for|no se encontr[óo] ning[úu]n documento|did not match any/i;

export function classifyGoogleHtml(html: string, parsedCount: number): { status: EngineStatus; detail?: string } {
  if (parsedCount > 0) return { status: "ok" };
  if (GOOGLE_BLOCK_RE.test(html)) return { status: "blocked", detail: "Google returned a captcha / unusual-traffic page" };
  if (GOOGLE_NO_RESULTS_RE.test(html)) return { status: "no_results" };
  return {
    status: "unparsed",
    detail: "Google page returned but no organic results could be parsed (markup change or silent block)",
  };
}

/** Bing: `.b_no` is its "no results" panel; it also shows up for silently-blocked sessions. */
export function classifyBingHtml(html: string, parsedCount: number): { status: EngineStatus; detail?: string } {
  if (parsedCount > 0) return { status: "ok" };
  const $ = cheerio.load(html);
  if ($(".b_no").length || /n[ãa]o h[áa] resultados|there are no results for/i.test(html)) {
    return { status: "no_results", detail: "Bing returned its empty-results panel (.b_no)" };
  }
  if (/captcha|unusual traffic|challenge/i.test(html) && $("li.b_algo").length === 0) {
    return { status: "blocked", detail: "Bing returned a challenge page" };
  }
  return { status: "unparsed", detail: "Bing page returned but no results could be parsed" };
}

/** DuckDuckGo html endpoint: HTTP 202 or an anomaly modal means a bot challenge. */
export function classifyDuckDuckGoHtml(
  html: string,
  parsedCount: number,
  statusCode?: number,
): { status: EngineStatus; detail?: string } {
  if (parsedCount > 0) return { status: "ok" };
  if (statusCode === 202 || /anomaly-modal|anomaly\.js|bots use duckduckgo too|challenge-form/i.test(html)) {
    return { status: "blocked", detail: "DuckDuckGo returned a bot challenge" };
  }
  if (/no more results|no results\.?<|Nenhum resultado/i.test(html)) return { status: "no_results" };
  return { status: "unparsed", detail: "DuckDuckGo page returned but no results could be parsed" };
}

// ---------------------------------------------------------------------------
// Alternative engines (Google is often captcha'd/429'd behind our proxies)
// ---------------------------------------------------------------------------

/**
 * Bing wraps result links as `https://www.bing.com/ck/a?...&u=a1<base64url(real url)>`.
 * Returns the real URL, the href itself when it is not wrapped, or undefined.
 */
export function decodeBingHref(href: string): string | undefined {
  try {
    const u = new URL(href);
    if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith("/ck/")) {
      const enc = u.searchParams.get("u") ?? "";
      if (!enc.startsWith("a1")) return undefined;
      const real = Buffer.from(enc.slice(2), "base64url").toString("utf8");
      return /^https?:\/\//i.test(real) ? real : undefined;
    }
    return /^https?:$/.test(u.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Bing: organic results are `li.b_algo > h2 > a`. */
export function parseBingResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $("li.b_algo").each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    const $a = $el.find("h2 > a").first();
    const url = decodeBingHref($a.attr("href") ?? "");
    const title = $a.text().trim();
    const snippet = $el.find(".b_caption p, .b_paractl").first().text().trim();
    if (url && title) results.push({ title, url, snippet });
  });
  return results;
}

/**
 * DuckDuckGo's no-JS endpoint wraps every link as `//duckduckgo.com/l/?uddg=<real url>&rut=...`.
 * The previous parser required `href` to start with "http", so it dropped every result.
 */
export function decodeDuckDuckGoHref(href: string): string | undefined {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (u.hostname.endsWith("duckduckgo.com")) {
      const real = u.searchParams.get("uddg");
      return real && /^https?:\/\//i.test(real) ? real : undefined;
    }
    return /^https?:\/\//i.test(href) ? href : undefined;
  } catch {
    return undefined;
  }
}

export function parseDuckDuckGoResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $(".result__body").each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    if ($el.closest(".result--ad").length) return;
    const $a = $el.find("a.result__a").first();
    const url = decodeDuckDuckGoHref($a.attr("href") ?? "");
    const title = $a.text().trim();
    const snippet = $el.find(".result__snippet").first().text().trim();
    if (url && title) results.push({ title, url, snippet });
  });
  return results;
}

/** Brave Search (search.brave.com is server-rendered): `div.snippet[data-type=web]`. */
export function parseBraveResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  $('div.snippet[data-type="web"]').each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    const url = $el.find('a[href^="http"]').first().attr("href") ?? "";
    const title = $el.find(".title").first().text().replace(/\s+/g, " ").trim();
    const snippet = $el.find(".generic-snippet .content, .snippet-description").first().text().replace(/\s+/g, " ").trim();
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    results.push({ title, url, snippet });
  });
  return results;
}

export function classifyBraveHtml(
  html: string,
  parsedCount: number,
  statusCode?: number,
): { status: EngineStatus; detail?: string } {
  if (parsedCount > 0) return { status: "ok" };
  const $ = cheerio.load(html);
  const head = `${$("title").text()} ${$("form").attr("action") ?? ""}`;
  // Real block (2026-10-01): HTTP 429, title "Brave Search", body "...flagged as being suspicious
  // and Brave Search decided to schedule a captcha...". Result pages also contain the word
  // "captcha" (i18n strings), so the body text alone is not a signal.
  if (
    statusCode === 429 ||
    /decided to schedule a captcha/i.test(html) ||
    /captcha|verify you are human|rate limit|too many requests/i.test(head) ||
    $("#captcha, .captcha").length
  ) {
    return { status: "blocked", detail: "Brave returned a captcha / rate-limit page" };
  }
  if (/Not many great matches|No results found/i.test($("main").text())) return { status: "no_results" };
  return { status: "unparsed", detail: "Brave page returned but no results could be parsed" };
}

// ---------------------------------------------------------------------------
// Platform-native search (no search engine in the middle)
// ---------------------------------------------------------------------------

/**
 * Extract the `ytInitialData` JSON blob from a YouTube page. Scans for the balanced object
 * instead of relying on what follows it: the blob is not always followed by `;</script>`
 * (a live run got a page the old `;</script>` regex could not read: status "unparsed").
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractYtInitialData(html: string): any | undefined {
  const m = /(?:var\s+ytInitialData|window\[["']ytInitialData["']\])\s*=\s*\{/.exec(html);
  if (!m) return undefined;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ytText = (t: any): string => String(t?.simpleText ?? (t?.runs ?? []).map((r: any) => r.text).join("")).trim();

/**
 * YouTube /results page -> videos and channels. Channels matter for brand protection
 * (look-alike channels), so they are kept as `https://www.youtube.com/@handle`.
 */
export function parseYouTubeResults(html: string, limit: number): SearchResult[] {
  const data = extractYtInitialData(html);
  if (!data) return [];
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const push = (r: SearchResult) => {
    if (out.length < limit && r.title && !seen.has(r.url)) {
      seen.add(r.url);
      out.push(r);
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (o: any): void => {
    if (!o || typeof o !== "object" || out.length >= limit) return;
    if (o.videoRenderer?.videoId) {
      const v = o.videoRenderer;
      const owner = v.ownerText?.runs?.[0];
      const ownerUrl = owner?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl;
      const desc = ytText(v.detailedMetadataSnippets?.[0]?.snippetText ?? v.descriptionSnippet);
      push({
        title: ytText(v.title),
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        snippet: [owner?.text, typeof ownerUrl === "string" && ownerUrl.startsWith("/") ? `https://www.youtube.com${ownerUrl}` : "", desc]
          .filter(Boolean)
          .join(" · "),
      });
      return;
    }
    if (o.channelRenderer?.channelId) {
      const c = o.channelRenderer;
      const base = c.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl;
      const path = typeof base === "string" && base.startsWith("/") ? base : `/channel/${c.channelId}`;
      push({
        title: ytText(c.title),
        url: `https://www.youtube.com${path}`,
        snippet: [ytText(c.subscriberCountText), ytText(c.videoCountText), ytText(c.descriptionSnippet)].filter(Boolean).join(" · "),
      });
      return;
    }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
  };
  walk(data);
  return out;
}

/** Pinterest `/resource/BaseSearchResource/get/` JSON (a browser layer wraps it, HTML-escaped, in <pre>). */
export function parsePinterestSearch(body: string, limit: number): SearchResult[] {
  // Browser layers render the JSON as HTML (<pre>, entities escaped): read the text back.
  const text = /^\s*</.test(body) ? cheerio.load(body)("body").text() : body;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = json?.resource_response?.data?.results ?? [];
  const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const out: SearchResult[] = [];
  for (const p of items) {
    if (out.length >= limit) break;
    if (p?.type !== "pin" || !p.id) continue; // skip "story" modules (related searches)
    const title = str(p.grid_title) || str(p.title) || str(p.description).slice(0, 120) || `Pin ${p.id}`;
    const parts = [str(p.description), p.pinner?.username ? `@${p.pinner.username}` : "", str(p.link)];
    out.push({ title, url: `https://www.pinterest.com/pin/${p.id}/`, snippet: parts.filter(Boolean).join(" · ") });
  }
  return out;
}

/** BaseSearchResource URL for a pins query (public, no login). */
export function pinterestSearchUrl(query: string): string {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`;
  const data = JSON.stringify({ options: { query, scope: "pins", bookmarks: [] }, context: {} });
  return `https://br.pinterest.com/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(data)}`;
}

// ---------------------------------------------------------------------------
// Platform data for brand protection (price / seller / author), read on the platform
// ---------------------------------------------------------------------------

/** Drop undefined/empty fields so `details` only carries what the platform really gave. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)),
  ) as T;
}

/** Lowercase, no accents, alphanumerics only: "Body Splash" and "body-splash" match "bodysplash". */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * VTEX public catalog search (no login or key), full-text `ft`, in-stock only (a listing without
 * stock is not a takedown target). NOT Intelligent Search: on americanas.com.br (2026-10-06) IS
 * answers 0 products + `redirect` for any term with a merchandising rule ("body splash" ->
 * category page) and is fuzzy (a brand term matched a different word); the catalog API does neither. Max 50/page.
 */
export function vtexSearchUrl(origin: string, query: string, count: number): string {
  return (
    `${origin}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(query)}` +
    `&fq=isAvailablePerSalesChannel_1:1&_from=0&_to=${Math.min(Math.max(count, 1), 50) - 1}`
  );
}

interface VtexOffer {
  seller: string;
  seller_id?: string;
  price: number;
  qty: number;
}

/**
 * VTEX product search JSON (catalog API: an array; Intelligent Search: `{products}`) -> one result
 * per product, with the cheapest in-stock offer's price and seller. A product sold by several 3P
 * sellers lists all of them in `details.offers`.
 */
export function parseVtexSearch(body: string, origin: string, limit: number): SearchResult[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = safeJson(body);
  const out: SearchResult[] = [];
  for (const p of Array.isArray(json) ? json : (json?.products ?? [])) {
    if (out.length >= limit) break;
    if (typeof p?.link !== "string" || !p.productName) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offers: VtexOffer[] = (p.items ?? []).flatMap((it: any) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (it?.sellers ?? []).map((s: any) => ({
        seller: String(s?.sellerName ?? ""),
        seller_id: s?.sellerId != null ? String(s.sellerId) : undefined,
        price: Number(s?.commertialOffer?.Price) || 0,
        qty: Number(s?.commertialOffer?.AvailableQuantity) || 0,
      })),
    );
    const inStock = offers.filter((o) => o.price > 0 && o.qty > 0).sort((a, b) => a.price - b.price);
    // Same seller on several SKUs: keep its cheapest offer once.
    const bySeller = new Map<string, { seller: string; seller_id?: string; price: number }>();
    for (const o of inStock) if (!bySeller.has(o.seller)) bySeller.set(o.seller, compact({ seller: o.seller, seller_id: o.seller_id, price: o.price }));
    const best = inStock[0];
    const details = compact<PlatformDetails>({
      price: best?.price,
      currency: best ? "BRL" : undefined,
      seller: best?.seller || undefined,
      seller_id: best?.seller_id,
      offers: bySeller.size > 1 ? [...bySeller.values()] : undefined,
      // "Não Disponível" is VTEX's placeholder for a product without a brand.
      brand: typeof p.brand === "string" && !/^n[aã]o dispon[ií]vel$/i.test(p.brand.trim()) ? p.brand.trim() : undefined,
      available: inStock.length > 0,
    });
    out.push({
      title: String(p.productName).trim(),
      url: new URL(p.link, origin).href,
      snippet: [
        best ? `R$ ${best.price.toFixed(2)}` : "sem estoque",
        best?.seller ? `vendido por ${best.seller}` : "",
        details.brand ? `marca ${details.brand}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      details,
    });
  }
  return out;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kwaiVideo(v: any): SearchResult | undefined {
  if (typeof v?.url !== "string" || !/^https:\/\/(?:www\.|m\.)?kwai\.com\//.test(v.url)) return undefined;
  const who = v.creator?.mainEntity ?? {};
  const text = [str(v.description), str(v.transcript)].filter(Boolean).join(" · ").slice(0, 500);
  return {
    title: str(v.name) || str(v.description) || v.url,
    url: v.url,
    snippet: text,
    details: compact<PlatformDetails>({
      author: str(who.name) || undefined,
      author_handle: str(who.alternateName) || undefined,
      author_url: str(who.url) || undefined,
      text: text || undefined,
      published_at: str(v.uploadDate) || undefined,
    }),
  };
}

/**
 * Kwai SEO ld+json API (`POST /rest/o/w/seo/ldJson/getByType` with `{url}`), the JSON the
 * kwai.com pages are server-rendered from. A discover page answers an `ItemList` of videos;
 * a video page a single `VideoObject`. Both become results with the creator in `details`.
 */
export function parseKwaiLdJson(body: string, limit: number): SearchResult[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = safeJson(body);
  const out: SearchResult[] = [];
  for (const block of json?.data ?? []) {
    const node = typeof block?.innerHTML === "string" ? safeJson(block.innerHTML) : block?.innerHTML;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    const videos = n?.["@type"] === "VideoObject" ? [n] : (n?.itemListElement ?? []);
    for (const v of videos) {
      const r = out.length < limit ? kwaiVideo(v) : undefined;
      if (r && !out.some((o) => o.url === r.url)) out.push(r);
    }
  }
  return out;
}

/** Kwai discover page for a term, in the site's slug form ("Body Splash" -> /discover/body-splash). */
export function kwaiDiscoverUrl(query: string): string {
  return `https://www.kwai.com/discover/${encodeURIComponent(query.trim().toLowerCase().replace(/\s+/g, "-"))}`;
}

/**
 * TikTok embed player page (`/embed/v2/<videoId>`): server-rendered `__FRONTITY_CONNECT_STATE__`
 * with the video, its author and stats. Unlike /@user/video/<id> (WAF JS challenge) it answers a
 * plain Chrome-TLS request (verified 2026-10-06).
 */
export function parseTikTokEmbed(html: string): PlatformDetails | undefined {
  const m = /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state: any = m ? safeJson(m[1]) : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pages: any[] = Object.values(state?.source?.data ?? {});
  const page = pages.find((d) => d?.videoData?.itemInfos);
  const v = page?.videoData;
  // Removed/private video: the embed answers HTTP 400 with `video_v2_error` (errorCode 10204 seen).
  if (!v) return pages.some((d) => d?.isError && d?.errorCode) ? { available: false } : undefined;
  const item = v.itemInfos;
  const author = v.authorInfos ?? {};
  const n = (x: unknown) => (x === undefined || x === null || x === "" || isNaN(Number(x)) ? undefined : Number(x));
  const created = n(item.createTime);
  const stats = compact({ plays: n(item.playCount), likes: n(item.diggCount), comments: n(item.commentCount), shares: n(item.shareCount) });
  return compact<PlatformDetails>({
    author: str(author.nickName) || undefined,
    author_handle: str(author.uniqueId) || undefined,
    author_url: str(author.uniqueId) ? `https://www.tiktok.com/@${str(author.uniqueId)}` : undefined,
    followers: n(v.authorStats?.followerCount),
    text: str(item.text) || undefined,
    published_at: created ? new Date(created * 1000).toISOString() : undefined,
    is_ad: typeof item.isAd === "boolean" ? item.isAd : undefined,
    is_shop_video: item.isECVideo === undefined ? undefined : Boolean(Number(item.isECVideo)) || item.isECVideo === true,
    stats: Object.keys(stats).length ? (stats as Record<string, number>) : undefined,
  });
}

/** JSON string literal body (`a b`, `\/`) -> text. */
function jsonString(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const v = safeJson(`"${s}"`);
  return typeof v === "string" ? v.replace(/ /g, " ").trim() || undefined : undefined;
}

const JSON_STR = '((?:[^"\\\\]|\\\\.)*)'; // capture group: body of a JSON string literal

/**
 * Facebook page/profile HTML, logged out. The page name comes from og:title; followers, category
 * and the external website from the embedded Relay JSON (verified 2026-10-06 on a public page).
 * Returns undefined for a login wall / anything without an og:title.
 */
export function parseFacebookPage(html: string): PlatformDetails | undefined {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/.exec(html)?.[1];
  const name = og ? cheerio.load(`<i>${og}</i>`)("i").text().trim() : "";
  if (!name || /^(facebook|log in|entrar)\b/i.test(name)) return undefined;
  const pick = (re: RegExp) => jsonString(re.exec(html)?.[1]);
  return compact<PlatformDetails>({
    author: name,
    followers: pick(new RegExp(`"profile_social_context":\\{"content":\\[\\{"text":\\{.{0,800}?"text":"${JSON_STR}"`)),
    category: pick(new RegExp(`"category_name":"${JSON_STR}"`)),
    website: pick(new RegExp(`"WebsiteContextItemRenderer"[^{}]*?"context_item":\\{"plaintext_title":\\{[^{}]*?"text":"${JSON_STR}"`)),
  });
}
