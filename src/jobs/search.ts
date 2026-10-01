import { Job } from "bullmq";
import { extract } from "../engine/orchestrator.js";
import { cheerioFetch, ContentValidationError } from "../engine/cheerio-engine.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { childLogger } from "../utils/logger.js";
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
  type SearchResult,
  type EngineStatus,
} from "./search-parsers.js";

export type { SearchResult, EngineStatus } from "./search-parsers.js";
export type SearchEngine = "google" | "bing" | "duckduckgo" | "brave" | "youtube" | "pinterest" | "all" | "auto";

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

interface EngineOutcome {
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
async function fetchSerp(url: string, timeout: number): Promise<{ html: string; statusCode: number }> {
  try {
    return await cheerioFetch(url, timeout);
  } catch (err) {
    if (err instanceof ContentValidationError && err.html) return { html: err.html, statusCode: err.statusCode ?? 0 };
    throw err;
  }
}

async function withFreshIp(attempts: number, run: () => Promise<EngineOutcome>): Promise<EngineOutcome> {
  let last: EngineOutcome = { results: [], status: "error" };
  for (let i = 0; i < attempts; i++) {
    last = await settle(run());
    if (last.status === "ok" || last.status === "no_results") return last;
  }
  return last;
}

async function duckduckgoSearch(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  return withFreshIp(CHEAP_ENGINE_ATTEMPTS, () => duckduckgoOnce(query, limit, timeout));
}

async function duckduckgoOnce(
  query: string,
  limit: number,
  timeout: number,
): Promise<EngineOutcome> {
  // DuckDuckGo's HTML endpoint works without JS rendering (results come from Bing's index).
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { html, statusCode } = await fetchSerp(searchUrl, timeout);
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
  return withFreshIp(CHEAP_ENGINE_ATTEMPTS, () => braveOnce(query, limit, timeout));
}

async function braveOnce(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  const { html } = await fetchSerp(searchUrl, timeout);
  const results = parseBraveResults(html, limit);
  return { results, ...classifyBraveHtml(html, results.length) };
}

/** YouTube's own search: results are in the `ytInitialData` blob of /results. */
async function youtubeSearch(query: string, limit: number, timeout: number): Promise<EngineOutcome> {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=pt-BR&gl=BR`;
  const { html } = await extract(searchUrl, {
    timeout,
    waitUntil: "domcontentloaded",
    // A page without the blob is a consent wall / soft block: escalate instead of "0 results".
    requireContent: { pattern: /ytInitialData/ },
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

function runEngine(
  name: SingleEngine,
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
): Promise<EngineOutcome> {
  switch (name) {
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

/** Never throws: a failed engine becomes status "error". */
async function settle(p: Promise<EngineOutcome>): Promise<EngineOutcome> {
  try {
    return await p;
  } catch (err) {
    return { results: [], status: "error", detail: String((err as Error)?.message ?? err).slice(0, 300) };
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
    const toOutcome = (r: PromiseSettledResult<EngineOutcome>): EngineOutcome =>
      r.status === "fulfilled"
        ? r.value
        : { results: [], status: "error", detail: String((r.reason as Error)?.message ?? r.reason).slice(0, 300) };
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
    results = [];
    status = "no_results";
    for (const step of AUTO_CHAIN) {
      const outcomes = await Promise.all(step.map((e) => settle(runEngine(e, query, limit, lang, country, timeout))));
      step.forEach((e, i) => record(e, outcomes[i]));
      results = mergeResults(outcomes.map((o) => o.results), limit);
      if (results.length > 0) {
        status = "ok";
        detail = undefined;
        break;
      }
      // Keep the most informative verdict: "no_results" from any engine beats a block/error.
      const verdicts = outcomes.map((o) => o.status);
      status = verdicts.includes("no_results") ? "no_results" : verdicts[verdicts.length - 1];
      detail = outcomes.map((o, i) => `${step[i]}: ${o.status}${o.detail ? ` (${o.detail})` : ""}`).join("; ");
    }
    // Every engine was blocked/errored: that is a failure, not "no results".
    if (results.length === 0 && Object.values(reports).every((r) => r!.status === "blocked" || r!.status === "error")) {
      status = "blocked";
    } else if (results.length === 0 && status !== "no_results") {
      status = "unparsed";
    }
  } else {
    const o = await runEngine(engine, query, limit, lang, country, timeout);
    record(engine, o);
    results = o.results;
    status = o.results.length > 0 ? "ok" : o.status;
    detail = o.detail;
  }

  // 2. Optionally scrape each result page
  if (shouldScrape && results.length > 0) {
    await Promise.allSettled(
      results.map(async (result) => {
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
