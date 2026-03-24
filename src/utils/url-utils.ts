/**
 * Normalize a URL: lowercase host, remove trailing slash, remove fragment.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    let path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return raw;
  }
}

/**
 * Extract the registered domain (e.g. "example.com" from "sub.example.com").
 */
export function getRegisteredDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    const parts = hostname.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
  } catch {
    return url;
  }
}

/**
 * Check if URL is same domain (or sub-domain) as base.
 */
export function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const urlHost = new URL(url).hostname;
    const baseHost = new URL(baseUrl).hostname;
    return urlHost === baseHost || urlHost.endsWith(`.${baseHost}`);
  } catch {
    return false;
  }
}

/**
 * Filter a URL against allowed/blocked word lists.
 */
export function filterUrl(
  url: string,
  opts: {
    allowedWords?: string[];
    blockedWords?: string[];
    allowedPatterns?: string[];
    blockedPatterns?: string[];
  },
): boolean {
  const lower = url.toLowerCase();

  if (opts.blockedWords?.length) {
    if (opts.blockedWords.some((w) => lower.includes(w.toLowerCase()))) return false;
  }
  if (opts.blockedPatterns?.length) {
    if (opts.blockedPatterns.some((p) => lower.includes(p.toLowerCase()))) return false;
  }
  if (opts.allowedWords?.length) {
    if (!opts.allowedWords.some((w) => lower.includes(w.toLowerCase()))) return false;
  }
  if (opts.allowedPatterns?.length) {
    if (!opts.allowedPatterns.some((p) => lower.includes(p.toLowerCase()))) return false;
  }

  return true;
}

/**
 * Extract all links from a Cheerio-loaded document.
 */
export function extractLinksFromHtml(
  $: cheerio.CheerioAPI,
  baseUrl: string,
): string[] {
  const links: Set<string> = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
    try {
      const absolute = new URL(href, baseUrl).href;
      links.add(normalizeUrl(absolute));
    } catch {
      // skip invalid URLs
    }
  });
  return Array.from(links);
}

// Re-export cheerio type for convenience
import type * as cheerio from "cheerio";
