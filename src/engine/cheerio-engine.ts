import * as cheerio from "cheerio";
import { fetch } from "undici";
import UserAgent from "user-agents";
import { StealthClient, TLSFingerprintError } from "abrasio-sdk";
import { logger } from "../utils/logger.js";
import { getProxyAgentForUrl, getProxyUrlForUrl } from "../utils/proxy-region.js";
import { hasContent } from "../utils/content-guard.js";

export interface CheerioResult {
  html: string;
  statusCode: number;
  contentType: string;
}

/**
 * TLS/JA3 fingerprint impersonation for Layer 1 (curl-impersonate via the `impers`
 * native backend, same stack as abrasio-sdk's playbook-runner T0). A bare undici
 * fetch's TLS ClientHello is Node's own, not a browser's, regardless of the
 * User-Agent header — sites that fingerprint TLS always 403 it and force an
 * escalation to Playwright/Abrasio. This client makes Layer 1 itself look like a
 * real (rotating) Chrome, so those sites can succeed at the cheapest layer instead
 * of always paying for Layer 2/3.
 *
 * Proxy is a constructor-only option on StealthClient (no per-request override), and
 * ours varies per target country — so one client per distinct proxy URL, cached and
 * reused (construction is cheap/lazy: no native work until the first real request).
 * rotateImpersonation:true because Layer 1 hits many unrelated domains per process,
 * unlike playbook-runner's one-target-per-run T0 where a stable fingerprint matters
 * more than diversity.
 */
const stealthClients = new Map<string, StealthClient>();
function getStealthClient(url: string): StealthClient {
  const proxy = getProxyUrlForUrl(url) ?? "__direct__";
  let client = stealthClients.get(proxy);
  if (!client) {
    client = new StealthClient({ rotateImpersonation: true, proxy: proxy === "__direct__" ? undefined : proxy });
    stealthClients.set(proxy, client);
  }
  return client;
}
let useStealth = true;

/**
 * Layer 1: Lightweight HTTP fetch + Cheerio parse.
 * No browser needed — fast (~100ms), ideal for static sites.
 */
export async function cheerioFetch(
  url: string,
  timeout: number = 30_000,
): Promise<CheerioResult> {
  let html: string;
  let statusCode: number;
  let contentType: string;

  if (useStealth) {
    try {
      const res = await getStealthClient(url).request("GET", url, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
        },
        timeout,
        allowRedirects: true,
      });
      html = res.text;
      statusCode = res.statusCode;
      contentType = res.headers["content-type"] || "";
      return validateAndReturn(url, html, statusCode, contentType);
    } catch (err) {
      if (err instanceof TLSFingerprintError) {
        // Native backend (impers) not installed in this environment — fall back to
        // plain fetch for the rest of this process rather than retrying per request.
        useStealth = false;
        logger.warn("Stealth HTTP backend unavailable for Layer 1 — falling back to plain fetch", {
          error: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // Fallback: plain undici fetch (also the path once TLSFingerprintError disables stealth).
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
    contentType = response.headers.get("content-type") || "";
    html = await response.text();
    return validateAndReturn(url, html, response.status, contentType);
  } finally {
    clearTimeout(timer);
  }
}

function validateAndReturn(url: string, html: string, statusCode: number, contentType: string): CheerioResult {
  // Validate: minimum content, no captcha
  if (html.length < 50) {
    throw new Error("Response too short — likely empty or blocked");
  }
  if (!hasContent(html)) {
    throw new Error("CAPTCHA or challenge page detected");
  }
  if (statusCode >= 400) {
    throw new Error(`HTTP ${statusCode}`);
  }

  logger.debug("Cheerio fetch success", { url, status: statusCode, length: html.length });

  return { html, statusCode, contentType };
}

/**
 * Load HTML into Cheerio for DOM manipulation.
 */
export function loadCheerio(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}
