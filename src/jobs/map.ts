import { Job } from "bullmq";
import * as undici from "undici";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import { normalizeUrl, isSameDomain, filterUrl, extractLinksFromHtml, getRegisteredDomain } from "../utils/url-utils.js";
import { childLogger } from "../utils/logger.js";
import { getProxyAgentForUrl } from "../utils/proxy-region.js";
import { playwrightFetch } from "../engine/playwright-engine.js";
import { AbrasioSession, isAbrasioAvailable } from "../engine/abrasio-engine.js";

export interface MapJobData {
  url: string;
  options?: {
    allowed_words?: string[];
    blocked_words?: string[];
    max_urls?: number;
  };
}

export interface MapJobResult {
  success: boolean;
  total: number;
  links: string[];
  processing_time_ms: number;
}

const BFS_CONCURRENCY = 30;
const BFS_CONCURRENCY_BROWSER = 5;

type Engine = "cheerio" | "playwright" | "abrasio";

/**
 * Parse a single sitemap XML response and return discovered URLs.
 * Handles both urlset and sitemapindex formats.
 */
async function parseSitemapXml(xml: string, parser: XMLParser): Promise<{ urls: string[]; subSitemaps: string[] }> {
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch {
    return { urls: [], subSitemaps: [] };
  }
  const urls: string[] = [];
  const subSitemaps: string[] = [];

  if (parsed.sitemapindex?.sitemap) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];
    for (const s of sitemaps) {
      if (s.loc) subSitemaps.push(s.loc);
    }
  }

  if (parsed.urlset?.url) {
    const entries = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
    for (const u of entries) {
      if (u.loc) urls.push(u.loc);
    }
  }

  return { urls, subSitemaps };
}

/**
 * Try to fetch and parse sitemap.xml for URL discovery.
 * Fetches both candidates in parallel; sub-sitemaps also fetched in parallel.
 */
async function fetchSitemap(baseUrl: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const parser = new XMLParser({ ignoreAttributes: false });

  const fetchXml = async (sitemapUrl: string): Promise<string | null> => {
    try {
      const response = await undici.fetch(sitemapUrl, { signal: AbortSignal.timeout(10_000), dispatcher: getProxyAgentForUrl(sitemapUrl) });
      if (!response.ok) return null;
      const contentType = response.headers.get("content-type") ?? "";
      // Reject HTML responses — servers that serve a soft-404 HTML page at /sitemap.xml
      // would cause false positives and prevent the BFS from running
      if (contentType.includes("text/html")) return null;
      return await response.text();
    } catch {
      return null;
    }
  };

  // Fetch both candidates in parallel
  const candidateResults = await Promise.allSettled(candidates.map(fetchXml));

  const urls: string[] = [];
  const subSitemapLocs: string[] = [];

  for (const result of candidateResults) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const { urls: foundUrls, subSitemaps } = await parseSitemapXml(result.value, parser);
    urls.push(...foundUrls);
    subSitemapLocs.push(...subSitemaps);
  }

  // Fetch all sub-sitemaps in parallel
  if (subSitemapLocs.length > 0) {
    const subResults = await Promise.allSettled(subSitemapLocs.map(fetchXml));
    for (const result of subResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { urls: subUrls } = await parseSitemapXml(result.value, parser);
      urls.push(...subUrls);
    }
  }

  return urls;
}

/**
 * Crawl a page and extract all links via Cheerio (no browser).
 */
async function fetchPageLinks(url: string): Promise<string[]> {
  try {
    const response = await undici.fetch(url, {
      signal: AbortSignal.timeout(15_000),
      dispatcher: getProxyAgentForUrl(url),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MarkUDown/1.0; +https://scrapetechnology.com/markudown)",
        Accept: "text/html",
      },
    });
    if (!response.ok) return [];

    const html = await response.text();
    const $ = cheerio.load(html);
    return extractLinksFromHtml($, url);
  } catch {
    return [];
  }
}

/**
 * Fetch page links using Playwright (Patchright) for JS-rendered pages.
 */
async function fetchPageLinksPlaywright(url: string, log?: ReturnType<typeof childLogger>): Promise<string[]> {
  try {
    const { html } = await playwrightFetch(url, { waitUntil: "load", timeout: 20_000 });
    const $ = cheerio.load(html);
    return extractLinksFromHtml($, url);
  } catch (err) {
    log?.warn("fetchPageLinksPlaywright failed", { url, reason: String(err) });
    return [];
  }
}

/**
 * Fetch page links using an existing AbrasioSession tab.
 */
async function fetchPageLinksAbrasio(session: AbrasioSession, url: string, log?: ReturnType<typeof childLogger>): Promise<string[]> {
  try {
    const { html } = await session.fetch(url, 20_000);
    const $ = cheerio.load(html);
    return extractLinksFromHtml($, url);
  } catch (err) {
    log?.warn("fetchPageLinksAbrasio failed", { url, reason: String(err) });
    return [];
  }
}

/**
 * Detect which fetch engine can extract links from the given URL.
 * Tries Cheerio → Playwright → Abrasio in order.
 * Returns the working engine, the seed links already extracted (to avoid
 * re-fetching the start URL in BFS), and — for Abrasio — the open session
 * that the caller must close after use.
 */
export async function detectEngine(
  url: string,
  filterOpts: { allowedWords?: string[]; blockedWords?: string[] },
  log: ReturnType<typeof childLogger>,
): Promise<{ engine: Engine; seedLinks: string[]; abrasioSession?: AbrasioSession }> {
  // Layer 1: Cheerio (plain HTTP)
  const cheerioLinks = await fetchPageLinks(url);
  if (cheerioLinks.length > 0) {
    log.info("Engine detected", { engine: "cheerio", startUrl: url, seedLinks: cheerioLinks.length });
    return { engine: "cheerio", seedLinks: cheerioLinks };
  }

  // Layer 2: Playwright (headless browser)
  const playwrightLinks = await fetchPageLinksPlaywright(url, log);
  if (playwrightLinks.length > 0) {
    log.info("Engine detected", { engine: "playwright", startUrl: url, seedLinks: playwrightLinks.length });
    return { engine: "playwright", seedLinks: playwrightLinks };
  }
  log.info("Playwright returned 0 links", { url });

  // Layer 3: Abrasio (stealth browser) — only when configured
  log.info("Checking Abrasio availability", { available: isAbrasioAvailable() });
  if (isAbrasioAvailable()) {
    const session = new AbrasioSession(url, {}, 20_000);
    const abrasioLinks = await fetchPageLinksAbrasio(session, url, log);
    if (abrasioLinks.length > 0) {
      log.info("Engine detected", { engine: "abrasio", startUrl: url, seedLinks: abrasioLinks.length });
      // Return session for BFS reuse — caller is responsible for closing it
      return { engine: "abrasio", seedLinks: abrasioLinks, abrasioSession: session };
    }
    // Abrasio found nothing — close the session now
    await session.close();
  }

  // All engines returned 0 links — BFS will run with Cheerio and return only root URL
  log.info("Engine detected", { engine: "cheerio", startUrl: url, seedLinks: 0 });
  return { engine: "cheerio", seedLinks: [] };
}

/**
 * BFS crawl when sitemap is unavailable or returns too few URLs.
 * Visits pages level by level, collecting same-domain links up to maxUrls.
 *
 * engine / abrasioSession: determined once by detectEngine() before the crawl.
 * seedLinks: links already extracted from startUrl during engine detection —
 *   pre-populates the frontier so the start URL is never fetched twice.
 */
async function crawlBfs(
  startUrl: string,
  filterOpts: { allowedWords?: string[]; blockedWords?: string[] },
  maxUrls: number,
  maxDepth: number,
  log: ReturnType<typeof childLogger>,
  engine: Engine = "cheerio",
  abrasioSession?: AbrasioSession,
  seedLinks?: string[],
): Promise<Set<string>> {
  const visited = new Set<string>();
  const collected = new Set<string>();
  const startDomain = getRegisteredDomain(startUrl);
  const concurrency = engine === "cheerio" ? BFS_CONCURRENCY : BFS_CONCURRENCY_BROWSER;

  const normStart = normalizeUrl(startUrl);
  visited.add(normStart);
  collected.add(normStart);

  // Per-engine fetch dispatcher
  const fetchLinks = (u: string): Promise<string[]> => {
    if (engine === "playwright") return fetchPageLinksPlaywright(u);
    if (engine === "abrasio") return fetchPageLinksAbrasio(abrasioSession!, u);
    return fetchPageLinks(u);
  };

  // Pre-populate frontier from seedLinks when the start URL was already
  // fetched during engine detection (avoids a redundant HTTP/browser call).
  let frontier: string[];
  if (seedLinks && seedLinks.length > 0) {
    frontier = [];
    for (const link of seedLinks) {
      if (collected.size >= maxUrls) break;
      const norm = normalizeUrl(link);
      if (!visited.has(norm) && getRegisteredDomain(norm) === startDomain && filterUrl(norm, filterOpts)) {
        visited.add(norm);
        collected.add(norm);
        frontier.push(norm);
      }
    }
  } else {
    frontier = [normStart];
  }

  for (let depth = 0; depth < maxDepth && frontier.length > 0 && collected.size < maxUrls; depth++) {
    const nextFrontier: string[] = [];
    log.info("BFS depth start", { depth, frontierSize: frontier.length, collected: collected.size });

    for (let i = 0; i < frontier.length && collected.size < maxUrls; i += concurrency) {
      const chunk = frontier.slice(i, i + concurrency);
      const pageResults = await Promise.allSettled(chunk.map((u) => fetchLinks(u)));

      for (let j = 0; j < pageResults.length; j++) {
        const result = pageResults[j];
        if (result.status !== "fulfilled") {
          log.warn("BFS page fetch failed", { url: chunk[j], reason: String(result.reason) });
          continue;
        }
        const rawLinks = result.value;
        log.debug("BFS page crawled", { url: chunk[j], rawLinks: rawLinks.length });
        for (const link of rawLinks) {
          if (collected.size >= maxUrls) break;
          const norm = normalizeUrl(link);
          if (!visited.has(norm) && getRegisteredDomain(norm) === startDomain && filterUrl(norm, filterOpts)) {
            visited.add(norm);
            collected.add(norm);
            nextFrontier.push(norm);
          }
        }
        if (collected.size >= maxUrls) break;
      }
    }

    log.info("BFS depth complete", { depth, newLinks: nextFrontier.length, collected: collected.size });
    frontier = nextFrontier;
  }

  return collected;
}

export async function processMapJob(job: Job<MapJobData>): Promise<MapJobResult> {
  const log = childLogger({ jobId: job.id, queue: "map" });
  const start = Date.now();
  const { url, options = {} } = job.data;
  const maxUrls = options.max_urls ?? 1000;

  log.info("Map started", { url, maxUrls });

  const filterOpts = {
    allowedWords: options.allowed_words,
    blockedWords: options.blocked_words,
  };

  const allLinks = new Set<string>();

  // 1. Try sitemap first (fast, comprehensive)
  const sitemapLinks = await fetchSitemap(url);
  for (const link of sitemapLinks) {
    if (allLinks.size >= maxUrls) break;
    const norm = normalizeUrl(link);
    if (isSameDomain(norm, url) && filterUrl(norm, filterOpts)) {
      allLinks.add(norm);
    }
  }

  // 2. If sitemap returned results, also scrape homepage for any missing links
  if (sitemapLinks.length > 0) {
    const pageLinks = await fetchPageLinks(url);
    for (const link of pageLinks) {
      if (allLinks.size >= maxUrls) break;
      const norm = normalizeUrl(link);
      if (isSameDomain(norm, url) && filterUrl(norm, filterOpts) && !allLinks.has(norm)) {
        allLinks.add(norm);
      }
    }
  } else {
    // 3. No sitemap — detect engine then BFS crawl
    log.info("No sitemap found, falling back to BFS crawl", { url });

    const { engine, seedLinks, abrasioSession } = await detectEngine(url, filterOpts, log);

    try {
      const crawledLinks = await crawlBfs(url, filterOpts, maxUrls, 3, log, engine, abrasioSession, seedLinks);
      for (const link of crawledLinks) {
        allLinks.add(link);
      }
    } finally {
      if (abrasioSession) {
        await abrasioSession.close();
      }
    }
  }

  const links = Array.from(allLinks);
  log.info("Map completed", { url, total: links.length, ms: Date.now() - start });

  return {
    success: true,
    total: links.length,
    links,
    processing_time_ms: Date.now() - start,
  };
}
