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
