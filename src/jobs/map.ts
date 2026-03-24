import { Job } from "bullmq";
import { fetch } from "undici";
import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import { normalizeUrl, isSameDomain, filterUrl, extractLinksFromHtml } from "../utils/url-utils.js";
import { childLogger } from "../utils/logger.js";

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

/**
 * Try to fetch and parse sitemap.xml for URL discovery.
 */
async function fetchSitemap(baseUrl: string): Promise<string[]> {
  const urls: string[] = [];
  const sitemapUrls = [
    `${new URL(baseUrl).origin}/sitemap.xml`,
    `${new URL(baseUrl).origin}/sitemap_index.xml`,
  ];

  const parser = new XMLParser({ ignoreAttributes: false });

  for (const sitemapUrl of sitemapUrls) {
    try {
      const response = await fetch(sitemapUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;

      const xml = await response.text();
      const parsed = parser.parse(xml);

      // Handle sitemap index
      if (parsed.sitemapindex?.sitemap) {
        const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
          ? parsed.sitemapindex.sitemap
          : [parsed.sitemapindex.sitemap];
        for (const s of sitemaps) {
          if (s.loc) {
            try {
              const subResp = await fetch(s.loc, { signal: AbortSignal.timeout(10_000) });
              if (subResp.ok) {
                const subXml = await subResp.text();
                const subParsed = parser.parse(subXml);
                const subUrls = Array.isArray(subParsed.urlset?.url)
                  ? subParsed.urlset.url
                  : subParsed.urlset?.url ? [subParsed.urlset.url] : [];
                for (const u of subUrls) {
                  if (u.loc) urls.push(u.loc);
                }
              }
            } catch {}
          }
        }
      }

      // Handle regular urlset
      if (parsed.urlset?.url) {
        const entries = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
        for (const u of entries) {
          if (u.loc) urls.push(u.loc);
        }
      }
    } catch {
      // Sitemap not available, skip
    }
  }

  return urls;
}

/**
 * Crawl a page and extract all links via Cheerio (no browser).
 */
async function fetchPageLinks(url: string): Promise<string[]> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MarkUDown/1.0; +https://markudown.dev)",
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

  // 2. Also crawl the page for links not in sitemap
  const pageLinks = await fetchPageLinks(url);
  for (const link of pageLinks) {
    if (allLinks.size >= maxUrls) break;
    const norm = normalizeUrl(link);
    if (isSameDomain(norm, url) && filterUrl(norm, filterOpts)) {
      allLinks.add(norm);
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
