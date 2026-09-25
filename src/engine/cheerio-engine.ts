import * as cheerio from "cheerio";
import { fetch } from "undici";
import UserAgent from "user-agents";
import { StealthClient, TLSFingerprintError } from "abrasio-sdk";
import { logger } from "../utils/logger.js";
import { inferCountryFromUrl } from "../utils/proxy-region.js";
import { EgressPolicyError, proxyAgentFor, proxyUrlFor } from "../utils/egress.js";
import { looksBlocked } from "../utils/content-guard.js";

export interface CheerioResult {
  html: string;
  statusCode: number;
  contentType: string;
}

/**
 * Thrown by validateAndReturn() for a real, already-loaded response that just
 * doesn't qualify (empty, blocked, HTTP error status) — distinct from a
 * transport-level failure, so cheerioFetch's stealth-vs-plain-fetch retry logic
 * doesn't waste a second attempt re-fetching a page that already loaded fine.
 */
class ContentValidationError extends Error {}

/**
 * TLS/JA3 fingerprint impersonation for Layer 1 (curl-impersonate via the `impers`
 * native backend, same stack as abrasio-sdk's playbook-runner T0). A bare undici
 * fetch's TLS ClientHello is Node's own, not a browser's, regardless of the
 * User-Agent header — sites that fingerprint TLS always 403 it and force an
 * escalation to Playwright/Abrasio. This client makes Layer 1 itself look like a
 * real (rotating) Chrome, so those sites can succeed at the cheapest layer instead
 * of always paying for Layer 2/3.
 *
 * Proxy AND region are constructor-only options on StealthClient (no per-request
 * override), and both vary per target country — so one client per distinct
 * (proxy, region) pair, cached and reused (construction is cheap/lazy: no native
 * work until the first real request). region matters on its own, not just for
 * routing: StealthClient derives Accept-Language from it, and a request exiting
 * through a Brazilian proxy with an en-US Accept-Language is exactly the kind of
 * IP/language mismatch anti-bot fingerprinting looks for — silently undermining
 * the whole point of impersonating a real browser here. rotateImpersonation:true
 * because Layer 1 hits many unrelated domains per process, unlike playbook-runner's
 * one-target-per-run T0 where a stable fingerprint matters more than diversity.
 */
const stealthClients = new Map<string, StealthClient>();
function getStealthClient(url: string, geo: CheerioGeo = {}): StealthClient {
  const region = geo.country ?? inferCountryFromUrl(url);
  // Fail-closed: throws EgressPolicyError when no proxy applies (never a direct client).
  const proxy = proxyUrlFor(url, geo.country, geo.city) ?? "__direct__";
  const key = `${region}:${proxy}`;
  let client = stealthClients.get(key);
  if (!client) {
    client = new StealthClient({
      rotateImpersonation: true,
      region,
      proxy: proxy === "__direct__" ? undefined : proxy,
    });
    stealthClients.set(key, client);
  }
  return client;
}
let useStealth = true;

/**
 * Layer 1: Lightweight HTTP fetch + Cheerio parse.
 * No browser needed — fast (~100ms), ideal for static sites.
 */
/** Explicit egress geography (overrides the URL-TLD inference). */
export interface CheerioGeo {
  country?: string;
  city?: string;
}

export async function cheerioFetch(
  url: string,
  timeout: number = 30_000,
  geo: CheerioGeo = {},
): Promise<CheerioResult> {
  let html: string;
  let statusCode: number;
  let contentType: string;

  if (useStealth) {
    try {
      const res = await getStealthClient(url, geo).request("GET", url, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
        },
        // Capped well below the caller's full timeout: a hung/slow stealth
        // handshake should fail fast and hand off to the plain-fetch fallback
        // with most of the timeout budget still left, not burn nearly all of
        // it before falling back (confirmed live 2026-09-17 against
        // belezanaweb.com.br: the stealth attempt alone ate ~45s of a 45s
        // budget before timing out, then plain fetch resolved in ~2s once it
        // finally got a turn).
        timeout: Math.min(timeout, 10_000),
        allowRedirects: true,
      });
      html = res.text;
      statusCode = res.statusCode;
      contentType = res.headers["content-type"] || "";
      return validateAndReturn(url, html, statusCode, contentType);
    } catch (err) {
      // Any content-quality rejection from validateAndReturn (empty response,
      // captcha marker, HTTP >=400) is a real result — surface it as-is, don't
      // spend a second fetch attempt on a page that actually loaded.
      if (err instanceof ContentValidationError || err instanceof EgressPolicyError) {
        throw err;
      }

      if (err instanceof TLSFingerprintError) {
        // Native backend (impers) not installed in this environment — permanent
        // for the process, so disable stealth entirely rather than retrying it
        // on every future request.
        useStealth = false;
        logger.warn("Stealth HTTP backend unavailable for Layer 1 — falling back to plain fetch", {
          error: err.message,
        });
      } else {
        // Transient/connection-level failure (proxy dial, reset, timeout) —
        // likely unrelated to the target site or to fingerprinting. Retry THIS
        // request with plain fetch (still far cheaper than escalating to
        // Playwright/Abrasio) without disabling stealth for later requests.
        logger.debug("Stealth request failed, retrying this request with plain fetch", {
          url,
          error: (err as Error).message,
        });
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
      dispatcher: proxyAgentFor(url, geo.country, geo.city),
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
  // Validate: minimum content, no captcha. Deliberately NOT the full hasContent()
  // gate (200-char stripped-text floor) — that's a content-QUALITY judgment for
  // the caller to make (orchestrator.ts and dataset.ts both already re-check the
  // successful result with hasContent()/isThinOrBlocked()). This layer only
  // rejects a raw-empty response or a definite block marker; a short-but-real
  // page (no marker, under 200 chars of text) should still come back as a
  // successful fetch, not get mislabeled here as "CAPTCHA or challenge page
  // detected" when it's neither.
  if (html.length < 50) {
    throw new ContentValidationError("Response too short — likely empty or blocked");
  }
  if (looksBlocked(html)) {
    throw new ContentValidationError("CAPTCHA or challenge page detected");
  }
  if (statusCode >= 400) {
    throw new ContentValidationError(`HTTP ${statusCode}`);
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
