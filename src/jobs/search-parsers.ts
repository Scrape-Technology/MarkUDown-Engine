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

export function classifyBraveHtml(html: string, parsedCount: number): { status: EngineStatus; detail?: string } {
  if (parsedCount > 0) return { status: "ok" };
  const $ = cheerio.load(html);
  const head = `${$("title").text()} ${$("form").attr("action") ?? ""}`;
  // Brave's proof-of-work captcha / rate-limit page has no result list at all.
  if (/captcha|verify you are human|rate limit|too many requests/i.test(head) || $("#captcha, .captcha").length) {
    return { status: "blocked", detail: "Brave returned a captcha / rate-limit page" };
  }
  if (/Not many great matches|No results found/i.test($("main").text())) return { status: "no_results" };
  return { status: "unparsed", detail: "Brave page returned but no results could be parsed" };
}

// ---------------------------------------------------------------------------
// Platform-native search (no search engine in the middle)
// ---------------------------------------------------------------------------

/** Extract the `ytInitialData` JSON blob from a YouTube page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractYtInitialData(html: string): any | undefined {
  const m = html.match(/(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*(\{.*?\});\s*<\/script>/s);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
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
        snippet: [owner?.text, ownerUrl ? `https://www.youtube.com${ownerUrl}` : "", desc].filter(Boolean).join(" · "),
      });
      return;
    }
    if (o.channelRenderer?.channelId) {
      const c = o.channelRenderer;
      const path = c.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ?? `/channel/${c.channelId}`;
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
