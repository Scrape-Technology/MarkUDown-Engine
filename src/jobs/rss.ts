import { Job } from "bullmq";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { fetch } from "undici";
import { extract } from "../engine/orchestrator.js";
import { childLogger } from "../utils/logger.js";

export interface RssJobData {
  url: string;
  options?: {
    timeout?: number;
    max_items?: number;
    title?: string;
    description?: string;
  };
}

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

export interface RssJobResult {
  success: boolean;
  data: {
    url: string;
    feed_url?: string;
    feed_title?: string;
    items: RssItem[];
    items_count: number;
    /** "native_feed" = found and parsed a real RSS/Atom feed; "generated" = built from page HTML */
    source: "native_feed" | "generated";
  };
  processing_time_ms: number;
}

// ─── Common feed path suffixes to probe when no feed is found directly ────────
const FEED_PATHS = [
  "/feed",
  "/feed/",
  "/rss",
  "/rss/",
  "/rss.xml",
  "/feed.xml",
  "/atom.xml",
  "/feeds",
  "/feeds/",
  "/feed/rss",
  "/feed/atom",
  "/rss/index.xml",
  "/news/feed",
  "/blog/feed",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function stripHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve any href to an absolute URL.
 * Handles:
 *   - Absolute:            https://example.com/feed.xml
 *   - Protocol-relative:   //feeds.folha.uol.com.br/rss091.xml
 *   - Relative:            /rss.xml  or  ../feed
 */
function toAbsolute(href: string, base: string): string | null {
  if (!href) return null;
  try {
    if (href.startsWith("//")) {
      const protocol = new URL(base).protocol;
      return new URL(`${protocol}${href}`).href;
    }
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// ─── Encoding-aware fetch ─────────────────────────────────────────────────────

/**
 * Fetch a URL and return the body as a correctly-decoded string.
 *
 * Many RSS feeds (especially older Brazilian sites) declare ISO-8859-1 or
 * Windows-1252 encoding. Calling res.text() would silently corrupt accented
 * characters because undici defaults to UTF-8. This function:
 *   1. Reads the raw bytes (ArrayBuffer)
 *   2. Checks the XML declaration  (<?xml … encoding="ISO-8859-1"?>)
 *   3. Falls back to the Content-Type charset header
 *   4. Falls back to UTF-8
 * Then decodes with TextDecoder using the detected charset.
 */
async function fetchDecodedText(
  url: string,
  headers: Record<string, string>,
  timeout: number,
): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Peek at the first 200 bytes using ASCII (safe regardless of encoding)
  const peek = new TextDecoder("ascii", { fatal: false }).decode(bytes.subarray(0, 200));

  // XML declaration takes priority: <?xml version="1.0" encoding="ISO-8859-1"?>
  const xmlCharset = peek.match(/encoding=["']([^"']+)["']/i)?.[1]?.toLowerCase().trim();

  // Content-Type header as fallback: text/xml; charset=iso-8859-1
  const ctCharset = (res.headers.get("content-type") ?? "")
    .match(/charset=([^\s;]+)/i)?.[1]?.toLowerCase().trim();

  const charset = xmlCharset ?? ctCharset ?? "utf-8";

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

// ─── XML Parser ───────────────────────────────────────────────────────────────

/** Parse all items from an RSS 2.0 or Atom feed — no limit applied. */
function parseFeedXml(xml: string): { feedTitle: string; items: RssItem[] } | null {
  let parsed: any;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return null;
  }

  // RSS 2.0
  if (parsed?.rss?.channel) {
    const ch = parsed.rss.channel;
    const rawItems = Array.isArray(ch.item) ? ch.item : ch.item ? [ch.item] : [];
    const items: RssItem[] = rawItems.map((item: any) => ({
      title: stripHtml(item.title),
      link: String(item.link ?? item.guid?.["#text"] ?? item.guid ?? "").trim(),
      description: stripHtml(item.description ?? item["content:encoded"] ?? "").slice(0, 600),
      pubDate: item.pubDate ? String(item.pubDate) : undefined,
    })).filter((i: RssItem) => i.title && i.link);

    return { feedTitle: stripHtml(ch.title), items };
  }

  // Atom
  if (parsed?.feed) {
    const feed = parsed.feed;
    const rawEntries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];

    const items: RssItem[] = rawEntries.map((entry: any) => {
      let link = "";
      if (typeof entry.link === "string") {
        link = entry.link;
      } else if (entry.link?.["@_href"]) {
        link = entry.link["@_href"];
      } else if (Array.isArray(entry.link)) {
        const alt = entry.link.find((l: any) => !l["@_rel"] || l["@_rel"] === "alternate");
        link = alt?.["@_href"] ?? "";
      }
      return {
        title: stripHtml(entry.title?.["#text"] ?? entry.title),
        link: link.trim(),
        description: stripHtml(
          entry.summary?.["#text"] ?? entry.summary ??
          entry.content?.["#text"] ?? entry.content ?? "",
        ).slice(0, 600),
        pubDate: entry.published ?? entry.updated ?? undefined,
      };
    }).filter((i: RssItem) => i.title && i.link);

    return { feedTitle: stripHtml(feed.title?.["#text"] ?? feed.title), items };
  }

  return null;
}

// ─── Feed Link Discovery ──────────────────────────────────────────────────────

/**
 * Scan an HTML page for any URL that looks like a feed.
 * Covers both:
 *   1. <link type="application/rss+xml"> / <link type="application/atom+xml"> in <head>
 *   2. <a href="..."> links whose href ends in .xml / contains /rss/ /feed/ /atom/
 *      (handles protocol-relative URLs like //feeds.folha.uol.com.br/...)
 */
function findFeedLinksInHtml($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const add = (href: string | undefined) => {
    if (!href) return;
    const abs = toAbsolute(href, baseUrl);
    if (abs && !seen.has(abs)) { seen.add(abs); results.push(abs); }
  };

  // High-confidence: <link> tags in <head>
  $('link[type="application/rss+xml"], link[type="application/atom+xml"], link[type="application/feed+json"]')
    .each((_, el) => add($(el).attr("href")));

  // Medium-confidence: <a> hrefs that look like feed URLs
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const isFeed =
      /\.(xml|rss|atom)(\?.*)?$/i.test(href) ||
      /\/(rss|feed|atom|syndication)(\/|$|\?|\.)/i.test(href) ||
      /\/rss\d+\.(xml|rss)$/i.test(href);   // e.g. rss091.xml
    if (isFeed) add(href);
  });

  return results;
}

// ─── Core: fetch a URL and try to get feed items ─────────────────────────────

interface FeedResolution {
  feedTitle: string;
  feedUrl: string;
  items: RssItem[];
}

/** Fetch a single feed URL and parse it. Returns null on failure. */
async function fetchOneFeed(feedUrl: string, timeout: number): Promise<{ feedTitle: string; items: RssItem[] } | null> {
  try {
    const text = await fetchDecodedText(
      feedUrl,
      { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      timeout,
    );
    return parseFeedXml(text);
  } catch {
    return null;
  }
}

/**
 * Fetch `url` and try to resolve it into feed items.
 *
 * - If the response is XML → parse directly and return all items.
 * - If the response is HTML with a single feed link → fetch and parse it.
 * - If the response is a feed listing page (e.g. Folha's /feed/) with
 *   multiple feed links → fetch ALL feeds in parallel, merge all items,
 *   and deduplicate by URL.
 */
async function resolveFeed(url: string, timeout: number): Promise<FeedResolution | null> {
  let text: string;
  try {
    text = await fetchDecodedText(
      url,
      {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
        "User-Agent": "Mozilla/5.0 (compatible; RSSBot/1.0)",
      },
      timeout,
    );
  } catch {
    return null;
  }

  // Try to parse as XML feed directly
  const parsed = parseFeedXml(text);
  if (parsed && parsed.items.length > 0) {
    return { feedTitle: parsed.feedTitle, feedUrl: url, items: parsed.items };
  }

  // Not XML — look for feed links in the HTML (listing page or regular page)
  const $ = cheerio.load(text);
  const feedLinks = findFeedLinksInHtml($, url);
  if (feedLinks.length === 0) return null;

  // Fetch ALL feed links in parallel and merge their items
  const listingTitle = $("title").text().trim();
  const results = await Promise.allSettled(feedLinks.map((fl) => fetchOneFeed(fl, timeout)));

  const allItems: RssItem[] = [];
  let feedTitle = listingTitle;

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      const { items, feedTitle: ft } = result.value;
      allItems.push(...items);
      if (!feedTitle && ft) feedTitle = ft;
    }
  }

  if (allItems.length === 0) return null;

  // Deduplicate by link (same article may appear in multiple category feeds)
  const seen = new Set<string>();
  const unique = allItems.filter((item) => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });

  return { feedTitle, feedUrl: url, items: unique };
}

// ─── HTML Fallback ────────────────────────────────────────────────────────────

function extractItemsFromHtml($: cheerio.CheerioAPI, baseUrl: string, maxItems: number): RssItem[] {
  const items: RssItem[] = [];
  const selectors = [
    "article",
    '[class*="post"]',
    '[class*="article"]',
    '[class*="entry"]',
    '[class*="card"]',
    "li h2 a",
    "li h3 a",
  ];

  for (const selector of selectors) {
    if (items.length >= maxItems) break;

    $(selector).each((_, el) => {
      if (items.length >= maxItems) return;
      const $el = $(el);
      const $a = $el.is("a") ? $el : $el.find("a").first();
      const href = $a.attr("href");
      let link = "";
      if (href) link = toAbsolute(href, baseUrl) ?? href;

      const title = ($el.find("h1,h2,h3,h4").first().text() || $a.text()).trim();
      const description = $el.find("p").first().text().trim().slice(0, 500);
      const $time = $el.find("time").first();
      const pubDate = $time.attr("datetime") || $time.text().trim() || undefined;

      if (title && link && !items.some((i) => i.link === link)) {
        items.push({ title, link, description, pubDate });
      }
    });

    if (items.length > 0) break;
  }

  return items;
}

// ─── Job Handler ──────────────────────────────────────────────────────────────

export async function processRssJob(job: Job<RssJobData>): Promise<RssJobResult> {
  const log = childLogger({ jobId: job.id, queue: "rss" });
  const start = Date.now();
  const { url, options = {} } = job.data;
  const maxItems = options.max_items ?? 20;
  const timeout = options.timeout ? options.timeout * 1000 : 30_000;

  log.info("RSS job started", { url, maxItems });

  // ── Step 1: try the URL itself as a feed (XML or HTML feed-listing page) ──
  const direct = await resolveFeed(url, timeout);
  if (direct) {
    log.info("Feed resolved from submitted URL", { url, feedUrl: direct.feedUrl, items: direct.items.length });
    return {
      success: true,
      data: {
        url,
        feed_url: direct.feedUrl,
        feed_title: direct.feedTitle || options.title,
        items: direct.items,
        items_count: direct.items.length,
        source: "native_feed",
      },
      processing_time_ms: Date.now() - start,
    };
  }

  // ── Step 2: fetch the page via orchestrator and look for feed hints ────────
  log.info("URL is not a feed — fetching page to discover feed", { url });
  const pageResult = await extract(url, { timeout });
  const $ = cheerio.load(pageResult.html);

  // First check <link> tags in <head> (highest confidence)
  const headFeedLinks = findFeedLinksInHtml($, url).slice(0, 5);
  for (const feedLink of headFeedLinks) {
    const resolved = await resolveFeed(feedLink, timeout);
    if (resolved) {
      log.info("Feed resolved from page <link> tag", { url, feedUrl: resolved.feedUrl });
      return {
        success: true,
        data: {
          url,
          feed_url: resolved.feedUrl,
          feed_title: resolved.feedTitle || options.title,
          items: resolved.items,
          items_count: resolved.items.length,
          source: "native_feed",
        },
        processing_time_ms: Date.now() - start,
      };
    }
  }

  // ── Step 3: probe common feed paths relative to the base origin ────────────
  let baseOrigin: string;
  try {
    const parsed = new URL(url);
    baseOrigin = `${parsed.protocol}//${parsed.host}`;
  } catch {
    baseOrigin = url;
  }

  for (const path of FEED_PATHS) {
    const candidate = `${baseOrigin}${path}`;
    log.debug("Probing feed path", { candidate });
    const resolved = await resolveFeed(candidate, timeout);
    if (resolved) {
      log.info("Feed resolved from common path", { url, feedUrl: resolved.feedUrl });
      return {
        success: true,
        data: {
          url,
          feed_url: resolved.feedUrl,
          feed_title: resolved.feedTitle || options.title,
          items: resolved.items,
          items_count: resolved.items.length,
          source: "native_feed",
        },
        processing_time_ms: Date.now() - start,
      };
    }
  }

  // ── Step 4: no feed found — extract articles from page HTML ───────────────
  log.info("No feed found — generating from page HTML", { url });
  const items = extractItemsFromHtml($, url, maxItems);
  const pageTitle = $("title").text().trim() || new URL(url).hostname;

  return {
    success: true,
    data: {
      url,
      feed_title: options.title ?? pageTitle,
      items,
      items_count: items.length,
      source: "generated",
    },
    processing_time_ms: Date.now() - start,
  };
}
