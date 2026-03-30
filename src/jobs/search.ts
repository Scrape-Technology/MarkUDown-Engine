import { Job } from "bullmq";
import * as cheerio from "cheerio";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { childLogger } from "../utils/logger.js";
export interface SearchJobData {
  query: string;
  options?: {
    limit?: number;
    timeout?: number;
    include_html?: boolean;
    scrape_results?: boolean;
    lang?: string;
    country?: string;
  };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  markdown?: string;
  html?: string;
}

export interface SearchJobResult {
  success: boolean;
  query: string;
  total: number;
  data: SearchResult[];
  processing_time_ms: number;
}

/**
 * Parse organic search results from a rendered Google SERP HTML.
 * Called after Patchright (or Abrasio) has fully rendered the page.
 */
function parseGoogleResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  // Google wraps each organic result in a div.g or similar container.
  // We look for any container that has both an <a href> and an <h3>.
  $("div.g, div[data-hveid] > div > div").each((_, el) => {
    if (results.length >= limit) return;
    const $el = $(el);

    const $a = $el.find("a[href]").first();
    const href = $a.attr("href") ?? "";
    const title = $el.find("h3").first().text().trim();
    const snippet = $el
      .find(".VwiC3b, [data-sncf], span[style*='-webkit-line-clamp']")
      .first()
      .text()
      .trim();

    if (href.startsWith("http") && title) {
      results.push({ title, url: href, snippet });
    }
  });

  return results;
}

/**
 * Fetch Google search results using Patchright (Layer 2).
 *
 * Plain HTTP fetch is immediately blocked by Google — we skip Cheerio
 * (forcePlaywright: true) and go straight to the headless browser.
 * If Patchright is also blocked, the orchestrator falls through to Abrasio.
 */
async function googleSearch(
  query: string,
  limit: number,
  lang: string,
  country: string,
  timeout: number,
): Promise<SearchResult[]> {
  // Request more results than needed to account for ads/non-organic entries
  // that will be filtered out during parsing.
  const num = Math.min(limit * 3, 100);
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://www.google.com/search?q=${encodedQuery}&num=${num}&hl=${lang}&gl=${country}&pws=0`;

  // forcePlaywright: skip Cheerio — Google reliably blocks plain HTTP.
  // waitForSelector: wait for the organic results container before parsing.
  // country: use the explicit country parameter so the right proxy/browser is selected.
  const acceptLang = lang === "pt" ? "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" : `${lang};q=0.9,en-US;q=0.8,en;q=0.7`;

  const { html } = await extract(searchUrl, {
    timeout,
    forcePlaywright: true,
    waitUntil: "load",
    waitForSelector: "#search, #rso, div.g",
    country: country.toUpperCase(),
    
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

  return parseGoogleResults(html, limit);
}

export async function processSearchJob(job: Job<SearchJobData>): Promise<SearchJobResult> {
  const log = childLogger({ jobId: job.id, queue: "search" });
  const start = Date.now();
  const { query, options = {} } = job.data;
  const limit = options.limit ?? 5;
  const timeout = options.timeout ? options.timeout * 1000 : 30_000;
  const shouldScrape = options.scrape_results ?? true;

  log.info("Search started", { query, limit, scrape: shouldScrape });

  // 1. Get search results via Patchright-rendered Google SERP
  const results = await googleSearch(
    query,
    limit,
    options.lang ?? "pt",
    options.country ?? "br",
    timeout,
  );

  // 2. Optionally scrape each result page
  if (shouldScrape && results.length > 0) {
    await Promise.allSettled(
      results.map(async (result) => {
        try {
          const extracted = await extract(result.url, { timeout });
          const cleaned = cleanHtml(extracted.html, result.url, { mainContent: true });
          result.markdown = extracted.markdown ?? (await convertToMarkdown(cleaned.html));
          if (options.include_html) result.html = cleaned.html;
        } catch (err: any) {
          log.debug("Failed to scrape search result", { url: result.url, error: err.message });
        }
      }),
    );
  }

  await job.updateProgress(100);
  log.info("Search completed", { query, results: results.length, ms: Date.now() - start });

  return {
    success: true,
    query,
    total: results.length,
    data: results,
    processing_time_ms: Date.now() - start,
  };
}
