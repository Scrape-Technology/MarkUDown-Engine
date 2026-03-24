import * as cheerio from "cheerio";
import { fetch } from "undici";
import UserAgent from "user-agents";
import { logger } from "../utils/logger.js";
import { getProxyAgentForUrl } from "../utils/proxy-region.js";

export interface CheerioResult {
  html: string;
  statusCode: number;
  contentType: string;
}

const CAPTCHA_TERMS = [
  "captcha",
  "cf-challenge",
  "hcaptcha",
  "recaptcha",
  "challenge-platform",
  "just a moment",
  "checking your browser",
  "verify you are human",
];

function looksBlocked(html: string): boolean {
  const lower = html.toLowerCase();
  return CAPTCHA_TERMS.some((t) => lower.includes(t));
}

/**
 * Layer 1: Lightweight HTTP fetch + Cheerio parse.
 * No browser needed — fast (~100ms), ideal for static sites.
 */
export async function cheerioFetch(
  url: string,
  timeout: number = 30_000,
): Promise<CheerioResult> {
  const ua = new UserAgent({ deviceCategory: "desktop" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      dispatcher: getProxyAgentForUrl(url),
      headers: {
        "User-Agent": ua.toString(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "";
    const html = await response.text();

    // Validate: minimum content, no captcha
    if (html.length < 50) {
      throw new Error("Response too short — likely empty or blocked");
    }
    if (looksBlocked(html)) {
      throw new Error("CAPTCHA or challenge page detected");
    }
    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}`);
    }

    logger.debug("Cheerio fetch success", { url, status: response.status, length: html.length });

    return { html, statusCode: response.status, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load HTML into Cheerio for DOM manipulation.
 */
export function loadCheerio(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}
