import { Abrasio, AbrasioError, BlockedError, TimeoutError } from "abrasio-sdk";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { inferCountryFromUrl } from "../utils/proxy-region.js";

export interface AbrasioOptions {
  /** Proxy URL (e.g. "http://user:pass@host:port") */
  //proxy?: string;
  /** Custom HTTP headers to inject on the target page */
  headers?: Record<string, string>;
  /** Enable canvas + audio fingerprint noise (default: true) */
  fingerprintNoise?: boolean;
}

export interface AbrasioResult {
  html: string;
  markdown?: string;
  metadata?: Record<string, unknown>;
  statusCode: number;
}

/**
 * Build Abrasio constructor options.
 * We pass the target URL so the SDK can infer region/locale automatically
 * (cloud mode uses it for geo-routing; local mode ignores it).
 * No explicit region is set — let Abrasio decide.
 */
function buildAbrasioConfig(targetUrl: string, timeout: number, opts: AbrasioOptions) {
  const isCloudMode = config.ABRASIO_API_KEY;

  // let proxy = null;
  // if (!proxy && !isCloudMode && config.PROXY_URL && config.PROXY_USERNAME && config.PROXY_PASSWORD) {
  //   // Local mode only — cloud mode handles geo-routing internally.
  //   // Build an authenticated proxy URL: http://user+country:pass@host:port
  //   const country = inferCountryFromUrl(targetUrl);
  //   const user = encodeURIComponent(`${config.PROXY_USERNAME}${country}`);
  //   const pass = encodeURIComponent(config.PROXY_PASSWORD);
  //   proxy = config.PROXY_URL.replace("://", `://${user}:${pass}@`);
  // }

  return {
    apiKey: config.ABRASIO_API_KEY || undefined,
    apiUrl: config.ABRASIO_API_URL === "local" ? undefined : config.ABRASIO_API_URL || undefined,
    headless: true,
    timeout,
    url: targetUrl,
  };
}

const CAPTCHA_SELECTORS = [
  // reCAPTCHA
  "iframe[src*='recaptcha']",
  ".g-recaptcha",
  "#recaptcha",
  // hCaptcha
  "iframe[src*='hcaptcha']",
  ".h-captcha",
  // Cloudflare challenge
  "#cf-challenge-running",
  "#challenge-form",
  "#challenge-stage",
  ".cf-browser-verification",
  // DataDome
  "#datadome-captcha",
  // Generic
  "[id*='captcha']",
  "[class*='captcha']",
  "//*[contains(text(), 'verify you are human')]",
  "//*[contains(text(), 'Please verify your identity')]",
  "#captcha-container",
  "#lemin-form",
  ".turnstile"
];

const CAPTCHA_TITLE_PATTERNS = [/captcha/i, /challenge/i, /verify you are human/i, /robot/i, /just a moment/i];

/** Returns true if the page appears to be showing a captcha or bot challenge. */
async function isCaptchaPage(page: any): Promise<boolean> {
  const title = await page.title().catch(() => "");
  if (CAPTCHA_TITLE_PATTERNS.some((p) => p.test(title))) return true;

  for (const selector of CAPTCHA_SELECTORS) {
    const found = await page.$(selector).catch(() => null);
    if (found) return true;
  }
  return false;
}

/**
 * Waits until the captcha is resolved by the browser extensions or until the
 * captchaTimeout is exceeded. Polls every pollInterval ms.
 */
async function waitForCaptchaResolution(
  page: any,
  url: string,
  captchaTimeout = 90_000,
  pollInterval = 2_000,
): Promise<void> {
  logger.info("Abrasio: captcha detected — waiting for extension to resolve", { url });

  const deadline = Date.now() + captchaTimeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const stillCaptcha = await isCaptchaPage(page).catch(() => true);
    if (!stillCaptcha) {
      logger.info("Abrasio: captcha resolved — resuming extraction", { url });
      // Brief pause for the page to finish loading after captcha pass
      await page.waitForLoadState?.("domcontentloaded").catch(() => {});
      return;
    }

    logger.debug("Abrasio: captcha still present, waiting…", {
      url,
      remainingMs: deadline - Date.now(),
    });
  }

  throw new Error(`Abrasio: captcha was not resolved within ${captchaTimeout}ms`);
}

/** Fetch a single URL using a given Abrasio browser instance (one new tab, closed after). */
async function fetchWithInstance(
  abrasio: Abrasio,
  url: string,
  timeout: number,
  opts: AbrasioOptions,
): Promise<AbrasioResult> {
  const page = await abrasio.newPage();
  try {
    if (opts.headers && Object.keys(opts.headers).length > 0) {
      await page.setExtraHTTPHeaders(opts.headers);
    }

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    if (await isCaptchaPage(page)) {
      await waitForCaptchaResolution(page, url);
    }

    const statusCode = response?.status() ?? 200;
    const html = await page.content();
    const title = await page.title();

    logger.debug("Abrasio fetch success", {
      url,
      statusCode,
      mode: abrasio.isCloud ? "cloud" : "local",
    });

    return { html, statusCode, metadata: { title } };
  } catch (err: any) {
    if (err instanceof BlockedError) {
      throw new Error(`Abrasio: request blocked by target site (${err.statusCode ?? "unknown status"})`);
    }
    if (err instanceof TimeoutError) {
      throw new Error(`Abrasio: timed out after ${err.timeoutMs ?? timeout}ms`);
    }
    if (err instanceof AbrasioError) {
      throw new Error(`Abrasio: ${err.message}`);
    }
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Layer 3: Abrasio stealth engine — standalone (one browser per call).
 * Used by the orchestrator for individual scrape/extract/search requests.
 *
 * Supports two modes (auto-detected from ABRASIO_API_KEY):
 *   - Cloud mode (sk_...): managed session via Abrasio API + CDP
 *   - Local mode (ABRASIO_API_URL=local): Patchright with full fingerprint patches
 */
export async function abrasioFetch(
  url: string,
  timeout: number = 60_000,
  opts: AbrasioOptions = {},
): Promise<AbrasioResult> {
  const abrasio = new Abrasio(buildAbrasioConfig(url, timeout, opts));
  await abrasio.start();
  try {
    return await fetchWithInstance(abrasio, url, timeout, opts);
  } finally {
    await abrasio.close();
  }
}

/**
 * Persistent Abrasio browser session for crawl jobs.
 *
 * Starts the browser once using the root URL for region inference, then reuses
 * it across many URLs by opening and closing individual tabs (pages).
 * This avoids the startup overhead of launching a new browser for every URL.
 *
 * Usage:
 *   const session = new AbrasioSession('https://shopee.com.br', {}, 60_000);
 *   try {
 *     await Promise.all(urls.map(u => session.fetch(u, timeout)));
 *   } finally {
 *     await session.close();
 *   }
 */
export class AbrasioSession {
  private instance: Abrasio | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly targetUrl: string;
  private readonly opts: AbrasioOptions;
  private readonly defaultTimeout: number;

  constructor(targetUrl: string, opts: AbrasioOptions = {}, defaultTimeout = 60_000) {
    this.targetUrl = targetUrl;
    this.opts = opts;
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Ensures the browser is started. Safe to call concurrently —
   * only one browser will be launched even if called from multiple
   * parallel crawl workers at the same time.
   */
  private async ensureStarted(): Promise<Abrasio> {
    if (this.instance) return this.instance;

    if (!this.startPromise) {
      this.startPromise = (async () => {
        logger.info("Abrasio: starting persistent crawl session", { targetUrl: this.targetUrl });
        const abrasio = new Abrasio(buildAbrasioConfig(this.targetUrl, this.defaultTimeout, this.opts));
        await abrasio.start();
        this.instance = abrasio;
        logger.info("Abrasio: crawl session ready", {
          mode: abrasio.isCloud ? "cloud" : "local",
          liveViewUrl: abrasio.liveViewUrl ?? undefined,
        });
      })();
    }

    await this.startPromise;
    return this.instance!;
  }

  /** Fetch a URL by opening a new tab in the shared browser, then closing it. */
  async fetch(url: string, timeout?: number, opts?: AbrasioOptions): Promise<AbrasioResult> {
    const abrasio = await this.ensureStarted();
    return fetchWithInstance(abrasio, url, timeout ?? this.defaultTimeout, opts ?? this.opts);
  }

  /** Close the shared browser and release all resources. */
  async close(): Promise<void> {
    if (this.instance) {
      logger.info("Abrasio: closing crawl session");
      await this.instance.close().catch(() => {});
      this.instance = null;
      this.startPromise = null;
    }
  }
}

/**
 * Open a persistent Abrasio page for multi-step jobs (dataset pagination, etc.).
 * Returns the raw page object (Playwright-compatible) and a close() function.
 * The caller is responsible for closing via the returned close().
 */
export async function openAbrasioPersistentPage(
  url: string,
  timeout: number,
  opts: AbrasioOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ page: any; close: () => Promise<void> }> {
  const abrasio = new Abrasio(buildAbrasioConfig(url, timeout, opts));
  await abrasio.start();
  const page = await abrasio.newPage();
  return {
    page,
    close: async () => {
      await page.close().catch(() => {});
      await abrasio.close().catch(() => {});
    },
  };
}

/**
 * Returns true when Abrasio is available for use:
 *   - Cloud mode: ABRASIO_API_KEY starts with "sk_"
 *   - Local mode: ABRASIO_API_URL set to "local"
 */
export function isAbrasioAvailable(): boolean {
  if (config.ABRASIO_API_KEY) return true;
  if (config.ABRASIO_API_URL === "local") return true;
  return false;
}
