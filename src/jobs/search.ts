import { Job } from "bullmq";
import * as cheerio from "cheerio";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { childLogger } from "../utils/logger.js";
import {
  parseGoogleSerp,
  resolveGotoLinks,
  classifyGoogleHtml,
  classifyBingHtml,
  classifyDuckDuckGoHtml,
  type SearchResult,
  type EngineStatus,
} from "./search-parsers.js";

export type { SearchResult, EngineStatus } from "./search-parsers.js";
export type SearchEngine = "google" | "bing" | "duckduckgo" | "all";

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
  engines?: Partial<Record<Exclude<SearchEngine, "all">, EngineReport>>;
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

/**
 * Parse organic results from a rendered Bing SERP HTML.
 */
function parseBingResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $("li.b_algo").each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    const $a = $el.find("h2 > a").first();
    const href = $a.attr("href") ?? "";
    const title = $a.text().trim();
    const snippet = $el.find(".b_caption p, .b_paractl").first().text().trim();

    if (href.startsWith("http") && title) {
      results.push({ title, url: href, snippet });
    }
  });

  return results;
}

/**
 * Parse organic results from DuckDuckGo's no-JS HTML endpoint.
 */
function parseDuckDuckGoResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $(".result__body").each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);
    const $a = $el.find("a.result__a").first();
    const href = $a.attr("href") ?? "";
    const title = $a.text().trim();
    const snippet = $el.find(".result__snippet").first().text().trim();

    if (href.startsWith("http") && title) {
      results.push({ title, url: href, snippet });
    }
  });

  return results;
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

async function duckduckgoSearch(
  query: string,
  limit: number,
  timeout: number,
): Promise<EngineOutcome> {
  // DuckDuckGo's HTML endpoint works without JS rendering.
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  const { html, statusCode } = await extract(searchUrl, {
    timeout,
    // No forcePlaywright — plain HTTP or Cheerio layer is enough.
    waitUntil: "load",
  });

  const results = parseDuckDuckGoResults(html, limit);
  return { results, ...classifyDuckDuckGoHtml(html, results.length, statusCode) };
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
  const record = (name: Exclude<SearchEngine, "all">, o: EngineOutcome) => {
    reports[name] = { status: o.status, total: o.results.length, ...(o.detail ? { detail: o.detail } : {}) };
  };
  let results: SearchResult[];
  let status: EngineStatus;
  let detail: string | undefined;

  if (engine === "all") {
    // NOTE: "all" pays for Bing + DuckDuckGo even though both currently tend to
    // return empty/challenge pages (see engines[...] in the output). We only
    // *detect* that; skipping engines after consecutive failures would need state
    // shared across jobs/workers. Recommendation: clients should pin engine: "google".
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
  } else {
    const o =
      engine === "bing"
        ? await bingSearchDetailed(query, limit, lang, country, timeout)
        : engine === "duckduckgo"
          ? await duckduckgoSearch(query, limit, timeout)
          : await googleSearchDetailed(query, limit, lang, country, timeout);
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
