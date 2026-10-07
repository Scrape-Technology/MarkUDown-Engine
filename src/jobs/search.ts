import { Job } from "bullmq";
import { extract } from "../engine/orchestrator.js";
import { cheerioFetch, ContentValidationError, stealthPostJson } from "../engine/cheerio-engine.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { childLogger } from "../utils/logger.js";
import { acquireDomainSlot, domainOf } from "../utils/domain-throttle.js";
import { EgressPolicyError } from "../utils/egress.js";
import {
  parseGoogleSerp,
  resolveGotoLinks,
  classifyGoogleHtml,
  classifyBingHtml,
  classifyDuckDuckGoHtml,
  classifyBraveHtml,
  parseBingResults,
  parseDuckDuckGoResults,
  parseBraveResults,
  parseYouTubeResults,
  extractYtInitialData,
  parsePinterestSearch,
  pinterestSearchUrl,
  vtexSearchUrl,
  parseVtexSearch,
  parseKwaiLdJson,
  kwaiDiscoverUrl,
  parseTikTokEmbed,
  parseFacebookPage,
  normalizeForMatch,
  type SearchResult,
  type EngineStatus,
  type PlatformDetails,
} from "./search-parsers.js";

export type { SearchResult, EngineStatus, PlatformDetails } from "./search-parsers.js";
/**
 * Platform engines (the query is the bare term, not a `site:` query):
 *  - youtube / pinterest / americanas: the platform's own search.
 *  - kwai: Kwai's discover page for the term + `site:kwai.com` through "auto".
 *  - tiktok / facebook: `site:` through "auto" (no usable native search logged out).
 * americanas/kwai/tiktok/facebook results carry `details` (price, seller, author...) read on the
 * platform itself.
 */
export type SearchEngine =
  | "google" | "bing" | "duckduckgo" | "brave" | "youtube" | "pinterest"
  | "americanas" | "kwai" | "tiktok" | "facebook"
  | "all" | "auto";

export interface SearchJobData {
  query: string;
  options?: {
    limit?: number;
    timeout?: number;
    include_html?: boolean;
    scrape_results?: boolean;
    lang?: string;
    country?: string;
    engine?: SearchEngine;
  };
}

export interface EngineReport {
  status: EngineStatus;
  total: number;
  detail?: string;
}

/**
 * Output contract. `success`, `query`, `total`, `data`, `processing_time_ms` are
 * unchanged. Added (backward compatible):
 *  - `status`: "ok" (total>0) | "no_results" (engine answered: nothing matches) |
 *    "blocked" (captcha / challenge) | "unparsed" (page came back but nothing could
 *    be extracted - markup change or silent block) | "error".
 *    `success` is false ONLY for "blocked"/"error", so "total: 0 + success: true"
 *    means the engine really answered "no results" (or "unparsed", see `warning`).
 *  - `error`: human-readable reason when success is false.
 *  - `warning`: set when status is "unparsed".
 *  - `engines`: per-engine breakdown (status / total / detail).
 *  - each data item may carry `url_approximate: true` (URL rebuilt from Google's
 *    breadcrumb because the redirect could not be resolved).
 * With a single engine, when every extraction layer fails (e.g. Google captcha not
 * solved by Abrasio) the job still throws as before; the error message says why.
 */
export interface SearchJobResult {
  success: boolean;
  query: string;
  total: number;
  data: SearchResult[];
  processing_time_ms: number;
  status?: EngineStatus;
  error?: string;
  warning?: string;
  engines?: Partial<Record<Exclude<SearchEngine, "all" | "auto">, EngineReport>>;
}

export interface EngineOutcome {
  results: SearchResult[];
  status: EngineStatus;
  detail?: string;
}

/**
 * Fetch Google search results using Patchright (Layer 2).
 *
 * Plain HTTP fetch is immediately blocked by Google — we skip Cheerio
 * (forcePlaywright: true) and go straight to the headless browser.
 * If Patchright is also blocked, the orchestrator falls through to Abrasio.
 */
export async function googleSearch(
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
): Promise<SearchResult[]> {
  return (await googleSearchDetailed(query, limit, lang, country, timeout)).results;
}

async function googleSearchDetailed(
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
): Promise<EngineOutcome> {
  // Request more results than needed to account for ads/non-organic entries
  // that will be filtered out during parsing.
  const num = Math.min(limit * 3, 100);
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://www.google.com/search?q=${encodedQuery}&num=${num}&hl=${lang}&gl=${country}&pws=0`;

  // forcePlaywright: skip Cheerio — Google reliably blocks plain HTTP.
  // waitForSelector: wait for the organic results container before parsing.
  // NO explicit `country` here on purpose: google.* hosts resolve to the dedicated sticky
  // GOOGLE_PROXY_* (rotating port 9000 is blocked by Google; sticky 10000 works — see config.ts).
  // Passing country:"BR" would divert the search to the generic per-country proxy. The result
  // locale is already fixed by the gl/hl params in searchUrl.
  const acceptLang = lang === "pt" ? "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" : `${lang};q=0.9,en-US;q=0.8,en;q=0.7`;

  const { html } = await extract(searchUrl, {
    timeout,
    forcePlaywright: true,
    waitUntil: "load",
    waitForSelector: "#search, #rso, div.g",
    headers: {
      "accept": "*/*",
      "accept-language": acceptLang,
      "downlink": "6",
      "priority": "u=1, i",
      "referer": "https://www.google.com/",
      "rtt": "50",
      "sec-ch-prefers-color-scheme": "dark",
      "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"146\"",
      "sec-ch-ua-arch": "\"x86\"",
      "sec-ch-ua-bitness": "\"64\"",
      "sec-ch-ua-form-factors": "\"Desktop\"",
      "sec-ch-ua-full-version": "\"146.0.7680.165\"",
      "sec-ch-ua-full-version-list": "\"Chromium\";v=\"146.0.7680.165\", \"Not-A.Brand\";v=\"24.0.0.0\", \"Google Chrome\";v=\"146.0.7680.165\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-model": "\"\"",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-ch-ua-platform-version": "\"19.0.0\"",
      "sec-ch-ua-wow64": "?0",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      "x-browser-channel": "stable",
      "x-browser-copyright": "Copyright 2026 Google LLC. All Rights reserved.",
      "x-browser-validation": "LfmjnJqGD5Eus3i98IgXaWqUp3s=",
      "x-browser-year": "2026",
      },
  });

  // The Abrasio layer receives Google's no-JS markup: no div.g and opaque
  // relative /goto?url= links. Parse tolerant of both, then resolve the links.
  const raw = parseGoogleSerp(html, limit * 2);
  const { results } = await resolveGotoLinks(raw, limit);
  return { results, ...classifyGoogleHtml(html, results.length) };
}

export async function bingSearch(
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
): Promise<SearchResult[]> {
  return (await bingSearchDetailed(query, limit, lang, country, timeout)).results;
}

async function bingSearchDetailed(
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
): Promise<EngineOutcome> {
  const num = Math.min(limit * 3, 50);
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://www.bing.com/search?q=${encodedQuery}&count=${num}&cc=${country}&setlang=${lang}&nojsredir=1`;

  const { html } = await extract(searchUrl, {
    timeout,
    forcePlaywright: true,
    waitUntil: "load",
    waitForSelector: "li.b_algo, #b_results",
    country: country.toUpperCase(),
  });

  const results = parseBingResults(html, limit);
  return { results, ...classifyBingHtml(html, results.length) };
}

/**
 * One Cheerio request per attempt; every attempt leaves through the ROTATING proxy, i.e. a new
 * exit IP. Brave/DuckDuckGo blocks are per IP (measured 2026-10-01: the same query was captcha'd
 * on one IP and returned 20 results on the next), so a couple of ~2 s retries beat escalating.
 */
/**
 * One Cheerio request that hands back the page even when the generic captcha heuristic
 * rejected it: the engine's own classifier decides. (Brave's "no results" page trips the
 * generic marker — measured 2026-10-01 — which turned every empty query into an "error".)
 */
async function fetchSerp(
  url: string,
  timeout: number,
  fresh = false,
  country?: string,
): Promise<{ html: string; statusCode: number }> {
  try {
    const r = await cheerioFetch(url, timeout, { fresh, country });
    return { ...r, html: r.html.slice(0, MAX_BODY_CHARS) };
  } catch (err) {
    if (err instanceof ContentValidationError && err.html) {
      return { html: err.html.slice(0, MAX_BODY_CHARS), statusCode: err.statusCode ?? 0 };
    }
    throw err;
  }
}

/** Error text that may reach `engines[x].detail`: type (and status) only, never a URL or proxy text. */
export function safeErrorDetail(err: unknown): string {
  if (err instanceof ContentValidationError || err instanceof RetryableReadError) return err.message.slice(0, 120);
  const e = err as { name?: string; statusCode?: number; status?: number };
  const status = e?.statusCode ?? e?.status;
  return `${e?.name || "Error"}${status ? ` HTTP ${status}` : ""}`;
}

async function withFreshIp(attempts: number, run: (fresh: boolean) => Promise<EngineOutcome>): Promise<EngineOutcome> {
  let last: EngineOutcome = { results: [], status: "error" };
  for (let i = 0; i < attempts; i++) {
    // Retries open a new proxy connection (no keep-alive reuse) => new rotating exit IP.
    last = await settle(run(i > 0));
    if (last.status === "ok" || last.status === "no_results") return last;
  }
  return last;
}

async function duckduckgoSearch(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  return withFreshIp(CHEAP_ENGINE_ATTEMPTS, (fresh) => duckduckgoOnce(query, limit, timeout, fresh));
}

async function duckduckgoOnce(
  query: string,
  limit: number,
  timeout: number,
  fresh = false,
): Promise<EngineOutcome> {
  // DuckDuckGo's HTML endpoint works without JS rendering (results come from Bing's index).
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { html, statusCode } = await fetchSerp(searchUrl, timeout, fresh);
  const results = parseDuckDuckGoResults(html, limit);
  return { results, ...classifyDuckDuckGoHtml(html, results.length, statusCode) };
}

/**
 * Brave Search: independent index, server-rendered.
 * Brave and DuckDuckGo are fetched with ONE Cheerio request (stealth TLS, rotating proxy) and
 * never escalate to a browser: measured 2026-10-01, a Brave proof-of-work captcha cost 3+ min of
 * Patchright + Abrasio and was never solved. A block is reported and the next engine is tried.
 */
async function braveSearch(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  return withFreshIp(CHEAP_ENGINE_ATTEMPTS, (fresh) => braveOnce(query, limit, timeout, fresh));
}

async function braveOnce(query: string, limit: number, timeout: number, fresh = false): Promise<EngineOutcome> {
  const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  const { html, statusCode } = await fetchSerp(searchUrl, timeout, fresh);
  const results = parseBraveResults(html, limit);
  return { results, ...classifyBraveHtml(html, results.length, statusCode) };
}

/** YouTube's own search: results are in the `ytInitialData` blob of /results. */
async function youtubeSearch(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=pt-BR&gl=BR`;
  const { html } = await extract(searchUrl, {
    timeout,
    waitUntil: "domcontentloaded",
    // A page without the blob is a consent wall / soft block: escalate instead of "0 results".
    // The loader script mentions `a.ytInitialData` even on an empty shell: require the blob itself.
    requireContent: { pattern: /ytInitialData"?\]?\s*=\s*\{/ },
  });
  const results = parseYouTubeResults(html, limit);
  if (results.length) return { results, status: "ok" };
  return extractYtInitialData(html)
    ? { results, status: "no_results" }
    : { results, status: "unparsed", detail: "YouTube page had no parsable ytInitialData" };
}

/** Pinterest's own search API (public; needs the browser-like XHR headers, no login). */
async function pinterestSearch(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  const { html } = await extract(pinterestSearchUrl(query), {
    timeout,
    waitUntil: "load",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
      "x-pinterest-pws-handler": "www/search/[scope].js",
      "x-pinterest-source-url": `/search/pins/?q=${encodeURIComponent(query)}`,
    },
    requireContent: { pattern: /resource_response/ },
  });
  const results = parsePinterestSearch(html, limit);
  if (results.length) return { results, status: "ok" };
  return /resource_response/.test(html)
    ? { results, status: "no_results" }
    : { results, status: "unparsed", detail: "Pinterest search did not return resource_response JSON" };
}

const CHEAP_ENGINE_ATTEMPTS = 3;

type SingleEngine = Exclude<SearchEngine, "all" | "auto">;

type Record_ = (name: SingleEngine, o: EngineOutcome) => void;

function runEngine(
  name: SingleEngine,
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
  record: Record_ = () => {},
): Promise<EngineOutcome> {
  switch (name) {
    case "americanas":
      return americanasSearch(query, limit, timeout);
    case "kwai":
    case "tiktok":
    case "facebook":
      return platformSearch(name, query, limit, lang, country, timeout, record);
    case "bing":
      return bingSearchDetailed(query, limit, lang, country, timeout);
    case "duckduckgo":
      return duckduckgoSearch(query, limit, timeout);
    case "brave":
      return braveSearch(query, limit, timeout);
    case "youtube":
      return youtubeSearch(query, limit, timeout);
    case "pinterest":
      return pinterestSearch(query, limit, timeout);
    default:
      return googleSearchDetailed(query, limit, lang, country, timeout);
  }
}

/** A failed engine becomes status "error" — except EgressPolicyError, which always propagates. */
async function settle(p: Promise<EngineOutcome>): Promise<EngineOutcome> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof EgressPolicyError) throw err; // policy violation: never a soft "error"
    return { results: [], status: "error", detail: safeErrorDetail(err) };
  }
}

/**
 * "auto": cheap engines first, Google last. Brave + DuckDuckGo run in parallel on the
 * Cheerio layer (~2 s each, one request through the rotating proxy) and are merged; only
 * when both bring nothing do we pay for Bing, and only then for Google (browser + sticky
 * proxy, minutes when it is captcha'd). Measured 2026-09-30: Google failed 12/12 queries
 * (soft block on Patchright, captcha on Abrasio) while Brave answered `site:` queries.
 */
export const AUTO_CHAIN: SingleEngine[][] = [["brave", "duckduckgo"], ["bing"], ["google"]];

/**
 * Only results on `domain` (or a subdomain) count. An engine that answered with nothing on it
 * found nothing: Bing ignores `site:` when the term is quoted (2026-10-06: 10/10 off-platform
 * results), and that must not stop the auto chain as if it were an answer.
 */
export function onDomain(domain: string, o: EngineOutcome): EngineOutcome {
  const host = new RegExp(`(^|\\.)${domain.replace(/\./g, "\\.")}$`, "i");
  const kept = o.results.filter((r) => {
    try {
      return host.test(new URL(r.url).hostname);
    } catch {
      return false;
    }
  });
  if (kept.length || o.status !== "ok") return { ...o, results: kept };
  return { results: kept, status: "no_results", detail: `${o.results.length} results, none on ${domain}` };
}

async function autoSearch(
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
  record: Record_,
  domain?: string,
): Promise<EngineOutcome> {
  let results: SearchResult[] = [];
  let status: EngineStatus = "no_results";
  let detail: string | undefined;
  const seen: EngineStatus[] = [];
  for (const step of AUTO_CHAIN) {
    const outcomes = (await Promise.all(step.map((e) => settle(runEngine(e, query, limit, lang, country, timeout))))).map(
      (o) => (domain ? onDomain(domain, o) : o),
    );
    step.forEach((e, i) => record(e, outcomes[i]));
    seen.push(...outcomes.map((o) => o.status));
    results = mergeResults(outcomes.map((o) => o.results), limit);
    if (results.length > 0) return { results, status: "ok" };
    // Keep the most informative verdict: "no_results" from any engine beats a block/error.
    const verdicts = outcomes.map((o) => o.status);
    status = verdicts.includes("no_results") ? "no_results" : verdicts[verdicts.length - 1];
    detail = outcomes.map((o, i) => `${step[i]}: ${o.status}${o.detail ? ` (${o.detail})` : ""}`).join("; ");
  }
  // Every engine was blocked/errored: that is a failure, not "no results".
  if (seen.every((s) => s === "blocked" || s === "error")) status = "blocked";
  else if (status !== "no_results") status = "unparsed";
  return { results, status, detail };
}

// ---------------------------------------------------------------------------
// Platform engines: discovery + the data a takedown needs, read on the platform itself.
// All of it is Layer 1 (one Chrome-TLS request through the approved proxy, BR exit): measured
// 2026-10-06, the browser path on these pages costs 60-100 s per URL (TikTok WAF, Shein 909).
// ---------------------------------------------------------------------------

const AMERICANAS = "https://www.americanas.com.br";

/** Americanas runs on VTEX: its own Intelligent Search API brings price and the 3P seller. */
async function americanasSearch(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  return withFreshIp(CHEAP_ENGINE_ATTEMPTS, async (fresh) => {
    const { html, statusCode } = await fetchSerp(vtexSearchUrl(AMERICANAS, query, limit), timeout, fresh, "BR");
    const results = parseVtexSearch(html, AMERICANAS, limit);
    if (results.length) return { results, status: "ok" };
    if (/^\s*\[\s*\]\s*$/.test(html)) return { results, status: "no_results" }; // catalog API: []
    return {
      results,
      status: statusCode === 403 || statusCode === 429 ? "blocked" : "unparsed",
      detail: `VTEX search HTTP ${statusCode}`,
    };
  });
}

const KWAI_LDJSON_API = "https://www.kwai.com/rest/o/w/seo/ldJson/getByType";

/** Kwai's SEO JSON for one kwai.com page URL (discover or video): what the page renders from. */
function kwaiLdJson(pageUrl: string, timeout: number): Promise<{ text: string; statusCode: number }> {
  return stealthPostJson(KWAI_LDJSON_API, { url: pageUrl }, timeout, { country: "BR" }, {
    origin: "https://www.kwai.com",
    referer: pageUrl,
  });
}

/**
 * Kwai's discover page for the term. The web app has no live keyword search (its search call is
 * commented out in the bundle and /rest/o/w/pwa/feed/search answers empty, 2026-10-06); discover
 * pages exist for terms Kwai's SEO already knows. For an unknown term Kwai answers a generic
 * "latest videos" list: only videos whose text contains the term count.
 */
async function kwaiDiscover(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  const needle = normalizeForMatch(query);
  return withFreshIp(2, async () => {
    const { text, statusCode } = await kwaiLdJson(kwaiDiscoverUrl(query), timeout);
    const all = parseKwaiLdJson(text, 50);
    const results = all.filter((r) => normalizeForMatch(`${r.title} ${r.snippet}`).includes(needle)).slice(0, limit);
    if (results.length) return { results, status: "ok" };
    if (/"status":\s*200/.test(text)) {
      return { results, status: "no_results", detail: `discover page: ${all.length} videos, none about the term` };
    }
    return {
      results,
      status: statusCode === 403 || statusCode === 429 ? "blocked" : "unparsed",
      detail: `Kwai ld+json HTTP ${statusCode}`,
    };
  });
}

type Enricher = (key: string, timeout: number) => Promise<PlatformDetails | undefined>;

/** TikTok embed answers 503 "overload-protect" to ~1 in 2 requests (6 sequential tries, 2026-10-06): retry on new IPs. */
const ENRICH_ATTEMPTS = 5;

const FB_RESERVED =
  /^(?:groups|events|watch|marketplace|share|sharer|photo|photo\.php|photos|videos|reel|reels|story\.php|permalink\.php|login|help|pages|hashtag|ads|gaming|business|privacy|policies|people|public|search|l\.php|dialog|plugins|home\.php)$/i;

/** Facebook URL -> the page/profile it belongs to (a page's posts and videos belong to the page). */
export function facebookPageUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return undefined;
  if (u.pathname === "/profile.php") {
    const id = u.searchParams.get("id");
    return id && /^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : undefined;
  }
  const slug = u.pathname.split("/")[1];
  return slug && !FB_RESERVED.test(slug) && /^[A-Za-z0-9.-]+$/.test(slug) ? `https://www.facebook.com/${slug}` : undefined;
}

/** One Layer-1 GET on a new exit IP that hands back the page whatever the generic block heuristic says. */
async function fetchPage(url: string, timeout: number): Promise<string> {
  const { html, statusCode } = await fetchSerp(url, timeout, true, "BR");
  if (RETRYABLE_STATUS.has(statusCode)) throw new RetryableReadError(statusCode);
  return html.slice(0, MAX_BODY_CHARS);
}

/** Native engines parse at most this much of a response (a Facebook page is ~1.4 MB). */
export const MAX_BODY_CHARS = 3_000_000;

/** The only answers worth a retry on a new IP: rate limit / overload (TikTok embed 503 ~1 in 2). */
const RETRYABLE_STATUS = new Set([429, 503]);

/** Message carries the status only: it can reach `engines[x].detail`, so no URL, no proxy text. */
export class RetryableReadError extends Error {
  constructor(readonly statusCode: number) {
    super(`HTTP ${statusCode}`);
    this.name = "RetryableReadError";
  }
}

/** `match` turns a result URL into the key `read` needs (undefined = not this platform's page). */
async function kwaiLdJsonChecked(url: string, timeout: number): Promise<{ text: string; statusCode: number }> {
  const r = await kwaiLdJson(url, timeout);
  if (RETRYABLE_STATUS.has(r.statusCode)) throw new RetryableReadError(r.statusCode);
  return r;
}

export interface Enricher_ {
  match: (url: string) => string | undefined;
  read: Enricher;
}

export const ENRICHERS: Enricher_[] = [
  {
    // /@user/video/<id> sits behind a WAF JS challenge; the embed player page does not.
    match: (url) => /^https:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/]+\/video\/(\d+)/.exec(url)?.[1],
    read: async (id, timeout) => parseTikTokEmbed(await fetchPage(`https://www.tiktok.com/embed/v2/${id}`, timeout)),
  },
  {
    match: (url) => (/^https:\/\/(?:www\.|m\.)?kwai\.com\/@[^/]+\/video\/\d+/.test(url) ? url.split(/[?#]/)[0] : undefined),
    read: async (url, timeout) => parseKwaiLdJson((await kwaiLdJsonChecked(url, timeout)).text, 1)[0]?.details,
  },
  { match: facebookPageUrl, read: async (url, timeout) => parseFacebookPage(await fetchPage(url, timeout)) },
];

/** Parallel platform reads per job: bursts made TikTok's 503s worse (2/5 at 5-wide vs ~1 in 2 alone). */
const ENRICH_CONCURRENCY = 3;

/** Share of the job's `timeout` the whole enrichment may spend; later reads/attempts are cut. */
export const ENRICH_BUDGET = 0.4;

export interface EnrichOptions {
  /** Epoch ms after which no new read or retry starts (default: 40% of `timeout` from now). */
  deadline?: number;
  pauseMs?: number;
  enrichers?: Enricher_[];
  /** Per-domain concurrency gate (default: the shared domain-throttle). */
  acquire?: (domain: string) => Promise<() => Promise<void>>;
}

/**
 * Attach `details` to every result whose platform page can be read at Layer 1. One key (a
 * Facebook page behind several posts) is read once. A read is retried (new exit IP, `pauseMs`
 * apart, up to ENRICH_ATTEMPTS) ONLY on a transport error, HTTP 429 or 503; a page that was read
 * but has no data (login wall, deleted, no og:title) ends on the first attempt. Every read takes
 * a slot of the platform's domain (shared with dataset/extract, so queue concurrency × reads
 * cannot stack up) and nothing starts after the deadline. Returns how many results have details.
 */
export async function enrichResults(results: SearchResult[], timeout: number, opts: EnrichOptions = {}): Promise<number> {
  const deadline = opts.deadline ?? Date.now() + ENRICH_BUDGET * timeout;
  const pauseMs = opts.pauseMs ?? 1000;
  const enrichers = opts.enrichers ?? ENRICHERS;
  const acquire = opts.acquire ?? acquireDomainSlot;
  const cache = new Map<string, Promise<PlatformDetails | undefined>>();
  const attempt = async (read: Enricher, key: string, domain: string | null) => {
    for (let i = 0; i < ENRICH_ATTEMPTS; i++) {
      if (Date.now() >= deadline) return undefined;
      if (i) await new Promise((r) => setTimeout(r, pauseMs));
      const release = domain ? await acquire(domain) : async () => {};
      try {
        if (Date.now() >= deadline) return undefined; // the slot wait may have eaten the budget
        const d = await read(key, timeout);
        return d && Object.keys(d).length ? d : undefined; // read fine, nothing there: do not retry
      } catch (err) {
        if (err instanceof EgressPolicyError) throw err;
        // transport error / 429 / 503: next attempt, new exit IP
      } finally {
        await release();
      }
    }
    return undefined;
  };
  const queue = results.filter((r) => !r.details);
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const e = enrichers.find((x) => x.match(r!.url));
      const key = e?.match(r.url);
      if (!e || !key) continue;
      if (!cache.has(key)) cache.set(key, attempt(e.read, key, domainOf(r.url)));
      const d = await cache.get(key)!;
      if (d) r.details = d;
    }
  };
  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
  return results.filter((r) => r.details).length;
}

const PLATFORM_DOMAIN: Record<"kwai" | "tiktok" | "facebook", string> = {
  kwai: "kwai.com",
  tiktok: "tiktok.com",
  facebook: "facebook.com",
};

/**
 * `site:<platform> "<term>"` through the auto chain (plus Kwai's own discover page), then every
 * result read on the platform (details). A failed read keeps the SERP result as it was.
 */
async function platformSearch(
  name: keyof typeof PLATFORM_DOMAIN,
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
  record: Record_,
): Promise<EngineOutcome> {
  const term = query.replace(/"/g, "").trim();
  const domain = PLATFORM_DOMAIN[name];
  const runs = [settle(autoSearch(`site:${domain} "${term}"`, limit, lang, country, timeout, record, domain))];
  if (name === "kwai") runs.unshift(settle(kwaiDiscover(term, limit, timeout)));
  const labels = name === "kwai" ? ["native", "site"] : ["site"];
  const outcomes = await Promise.all(runs);
  const results = mergeResults(outcomes.map((o) => o.results), limit);
  const withDetails = await enrichResults(results, timeout);
  const detail = [
    ...outcomes.map((o, i) => `${labels[i]}: ${o.status}${o.detail ? ` (${o.detail})` : ""}`),
    `details ${withDetails}/${results.length}`,
  ].join("; ");
  if (results.length) return { results, status: "ok", detail };
  const verdicts = outcomes.map((o) => o.status);
  const status: EngineStatus = verdicts.includes("no_results")
    ? "no_results"
    : verdicts.every((v) => v === "blocked" || v === "error")
      ? "blocked"
      : "unparsed";
  return { results, status, detail };
}

/**
 * Merge results from multiple engines, deduplicating by URL.
 * Order: preserves round-robin interleaving across engines.
 */
function mergeResults(resultSets: SearchResult[][], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  const maxLen = Math.max(...resultSets.map((r) => r.length));

  for (let i = 0; i < maxLen && merged.length < limit; i++) {
    for (const set of resultSets) {
      if (i < set.length && !seen.has(set[i].url)) {
        seen.add(set[i].url);
        merged.push(set[i]);
        if (merged.length >= limit) break;
      }
    }
  }

  return merged;
}

export async function processSearchJob(job: Job<SearchJobData>): Promise<SearchJobResult> {
  const log = childLogger({ jobId: job.id, queue: "search" });
  const start = Date.now();
  const { query, options = {} } = job.data;
  const limit = options.limit ?? 5;
  const timeout = options.timeout ? options.timeout * 1000 : 30_000;
  const shouldScrape = options.scrape_results ?? true;

  const engine: SearchEngine = options.engine ?? "google";
  const lang = options.lang ?? "pt";
  const country = options.country ?? "br";

  log.info("Search started", { query, limit, engine, scrape: shouldScrape });

  // 1. Fetch results from the requested engine(s)
  const reports: NonNullable<SearchJobResult["engines"]> = {};
  const record = (name: SingleEngine, o: EngineOutcome) => {
    reports[name] = { status: o.status, total: o.results.length, ...(o.detail ? { detail: o.detail } : {}) };
  };
  let results: SearchResult[];
  let status: EngineStatus;
  let detail: string | undefined;

  if (engine === "all") {
    // NOTE: "all" pays for Bing + DuckDuckGo even though both currently tend to
    // return empty/challenge pages (see engines[...] in the output). We only
    // *detect* that; skipping engines after consecutive failures would need state
    // shared across jobs/workers. Recommendation: use engine: "auto" (cheap engines first).
    const [google, bing, ddg] = await Promise.allSettled([
      googleSearchDetailed(query, limit, lang, country, timeout),
      bingSearchDetailed(query, limit, lang, country, timeout),
      duckduckgoSearch(query, limit, timeout),
    ]);
    const toOutcome = (r: PromiseSettledResult<EngineOutcome>): EngineOutcome => {
      if (r.status === "fulfilled") return r.value;
      if (r.reason instanceof EgressPolicyError) throw r.reason; // never degrade a policy violation
      return { results: [], status: "error", detail: safeErrorDetail(r.reason) };
    };
    const g = toOutcome(google);
    const b = toOutcome(bing);
    const d = toOutcome(ddg);
    record("google", g);
    record("bing", b);
    record("duckduckgo", d);
    results = mergeResults([g.results, b.results, d.results], limit);
    // Google is the primary engine: when nothing came back, its verdict decides.
    status = results.length > 0 ? "ok" : g.status;
    detail = g.detail;
  } else if (engine === "auto") {
    ({ results, status, detail } = await autoSearch(query, limit, lang, country, timeout, record));
  } else {
    const o = await runEngine(engine, query, limit, lang, country, timeout, record);
    record(engine, o);
    results = o.results;
    status = o.results.length > 0 ? "ok" : o.status;
    detail = o.detail;
  }

  // 2. Optionally scrape each result page (not the ones a platform engine already read: their
  // generic page is a WAF/login wall, and escalating it would cost a browser per result).
  if (shouldScrape && results.length > 0) {
    await Promise.allSettled(
      results.filter((r) => !r.details).map(async (result) => {
        try {
          const extracted = await extract(result.url, { timeout });
          const cleaned = await cleanHtml(extracted.html, result.url, { mainContent: true });
          result.markdown = extracted.markdown ?? (await convertToMarkdown(cleaned.html));
          if (options.include_html) result.html = cleaned.html;
        } catch (err: any) {
          log.debug("Failed to scrape search result", { url: result.url, error: err.message });
        }
      }),
    );
  }

  await job.updateProgress(100);
  const failed = status === "blocked" || status === "error";
  if (results.length === 0 && status !== "no_results") {
    log.warn("Search returned no results", { query, engine, status, detail });
  }
  log.info("Search completed", { query, results: results.length, status, ms: Date.now() - start });

  return {
    success: !failed,
    query,
    total: results.length,
    data: results,
    processing_time_ms: Date.now() - start,
    status,
    ...(failed ? { error: detail ?? `Search ${status}` } : {}),
    ...(status === "unparsed" ? { warning: detail } : {}),
    engines: reports,
  };
}
