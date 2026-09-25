import { Abrasio, AbrasioError, BlockedError, TimeoutError } from "abrasio-sdk";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { EgressPolicyError, abrasioEgressFor, type AbrasioEgress } from "../utils/egress.js";
import { markIpBlocked } from "../utils/proxy-pool.js";

export interface AbrasioOptions {
  /** Proxy URL (e.g. "http://user:pass@host:port") */
  //proxy?: string;
  /** Custom HTTP headers to inject on the target page */
  headers?: Record<string, string>;
  /** Enable canvas + audio fingerprint noise (default: true) */
  fingerprintNoise?: boolean;
  /**
   * Route this session to Abrasio's home-server worker pool instead of the
   * normal ECS Fargate fleet — reserved for targets that need a persistent
   * logged-in session that only exists there (e.g. Shopee). Cloud mode only.
   * Usually set automatically for configured domains — see hard-route.ts —
   * rather than passed by callers directly.
   */
  hard?: boolean;
  /** Explicit target region (ISO alpha-2, e.g. "BR"): sent to Abrasio instead of letting it infer from the URL. */
  region?: string;
  /** City slug (e.g. "saopaulo") for the approved proxy; needs a country (region or inferred from the URL). */
  city?: string;
  /** Explicit egress proxy (structured, so the worker logs only `server`, never credentials). */
  proxy?: { server: string; username?: string; password?: string };
}

export interface AbrasioResult {
  html: string;
  markdown?: string;
  metadata?: Record<string, unknown>;
  statusCode: number;
}

/**
 * Build Abrasio constructor options.
 * We pass the target URL so the SDK can infer region/locale automatically.
 * The egress proxy is always explicit and approved (see abrasioProxyFor).
 */
async function buildAbrasioConfig(targetUrl: string, timeout: number, opts: AbrasioOptions) {
  // Egress (fail-closed): the cloud must never pick the exit IP itself (its provider is not
  // verifiable), so EVERY session carries an explicit approved proxy chosen by proxy-policy.ts.
  // Throws EgressPolicyError when none is configured. Log host/port only — never credentials.
  const egress = await abrasioEgressFor(targetUrl, opts);
  const proxy = egress.proxy;
  if (proxy) logger.info("Abrasio egress proxy", { pool: egress.pool ?? "explicit", proxy: egress.label });

  return {
    egress,
    cfg: {
      apiKey: config.ABRASIO_API_KEY || undefined,
      apiUrl: config.ABRASIO_API_URL === "local" ? undefined : config.ABRASIO_API_URL || undefined,
      headless: true,
      timeout,
      url: targetUrl,
      hard: opts.hard,
      // Only when the caller set them — otherwise behavior is unchanged.
      ...(opts.region ? { region: opts.region } : {}),
      ...(proxy ? { proxy } : {}),
    },
  };
}

const IP_ECHO_URL = "https://api.ipify.org?format=json";
export const READINESS_BUDGET_MS = 20_000;

/**
 * Readiness gate: after the session is created with a proxy and BEFORE navigating to the
 * target, prove the proxy tunnel is up with a short IP-echo navigation (which exits through the
 * proxy), retrying up to READINESS_BUDGET_MS. For a static ISP proxy the echoed IP must equal
 * the proxy host (proof of egress). Never resolves / mismatch => EgressPolicyError.
 */
export async function assertProxyReady(abrasio: Abrasio, egress: AbrasioEgress): Promise<string | undefined> {
  if (!egress.proxy || !config.PROXY_READINESS_GATE) return undefined;
  const deadline = Date.now() + READINESS_BUDGET_MS;
  let ip: string | undefined;
  let lastErr = "";
  while (!ip && Date.now() < deadline) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any;
    try {
      page = await abrasio.newPage();
      await page.goto(IP_ECHO_URL, { waitUntil: "domcontentloaded", timeout: Math.max(3_000, Math.min(8_000, deadline - Date.now())) });
      const body = JSON.parse(await page.evaluate("document.body.innerText"));
      if (typeof body?.ip === "string") ip = body.ip;
    } catch (e) {
      lastErr = String(e).slice(0, 120);
      await new Promise((r) => setTimeout(r, 1_000));
    } finally {
      await Promise.resolve(page?.close?.()).catch(() => {});
    }
  }
  if (!ip) {
    throw new EgressPolicyError(
      `Egress bloqueado (fail-closed): o túnel do proxy ${egress.label} não ficou pronto em ${READINESS_BUDGET_MS / 1000}s (${lastErr}).`,
    );
  }
  if (egress.ispIp && ip !== egress.ispIp) {
    throw new EgressPolicyError(
      `Egress bloqueado (fail-closed): IP de saída ${ip} difere do IP do proxy ISP ${egress.label} — o proxy não foi aplicado.`,
    );
  }
  logger.info("Abrasio proxy ready", { pool: egress.pool ?? "explicit", proxy: egress.label, exitIp: ip });
  return ip;
}

/**
 * Creates + starts an Abrasio session and runs the readiness gate. If a static ISP proxy fails
 * the gate, it is put in cooldown and ONE retry re-resolves (=> another ISP IP or Geonode).
 */
async function startAbrasio(url: string, timeout: number, opts: AbrasioOptions): Promise<{ abrasio: Abrasio; egress: AbrasioEgress }> {
  for (let attempt = 1; ; attempt++) {
    const { cfg, egress } = await buildAbrasioConfig(url, timeout, opts);
    const abrasio = new Abrasio(cfg);
    await abrasio.start();
    try {
      await assertProxyReady(abrasio, egress);
      return { abrasio, egress };
    } catch (err) {
      await abrasio.close().catch(() => {});
      if (egress.ispIp && attempt === 1 && err instanceof EgressPolicyError) {
        await markIpBlocked(egress.ispIp);
        continue;
      }
      throw err;
    }
  }
}

/** Blocking signal attributable to the proxy (captcha/403/429/thin): put its static IP in cooldown. */
export async function reportProxyBlocked(egress?: AbrasioEgress): Promise<void> {
  if (egress?.ispIp) await markIpBlocked(egress.ispIp);
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

/**
 * HTML content markers, checked separately from CAPTCHA_TITLE_PATTERNS/
 * CAPTCHA_SELECTORS above because those are English-centric and can miss a
 * localized challenge page outright. Confirmed 2026-08-19 against a real
 * Cloudflare Turnstile page (ligapokemon.com.br, pt-BR): titled "Um
 * momento…" — matches none of CAPTCHA_TITLE_PATTERNS — or these markers
 * live in the raw HTML (script src, hidden field name) regardless of the
 * page's display language, so they don't have the same blind spot.
 * Length-gated: a large real page mentioning "captcha" in passing shouldn't
 * be misread as a challenge — interstitials are inherently boilerplate-sized.
 */
const CAPTCHA_CONTENT_MARKERS = [
  "cf-turnstile", "challenges.cloudflare.com", "cf-chl-", "cf-please-wait", "/cdn-cgi/challenge-platform/",
];

/** Returns true if the page appears to be showing a captcha or bot challenge. */
export async function isCaptchaPage(page: any): Promise<boolean> {
  const title = await page.title().catch(() => "");
  if (CAPTCHA_TITLE_PATTERNS.some((p) => p.test(title))) return true;

  for (const selector of CAPTCHA_SELECTORS) {
    const found = await page.$(selector).catch(() => null);
    if (found) return true;
  }

  const html: string = await page.content().catch(() => "");
  if (html.length > 0 && html.length < 8_000) {
    const lower = html.toLowerCase();
    if (CAPTCHA_CONTENT_MARKERS.some((m) => lower.includes(m))) return true;
  }

  return false;
}

/**
 * Waits until the captcha is resolved by the browser extensions or until the
 * captchaTimeout is exceeded. Polls every pollInterval ms.
 */
export async function waitForCaptchaResolution(
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
  egress?: AbrasioEgress,
): Promise<AbrasioResult> {
  const page = await abrasio.newPage();
  try {
    if (opts.headers && Object.keys(opts.headers).length > 0) {
      await page.setExtraHTTPHeaders(opts.headers);
    }

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    if (await isCaptchaPage(page)) {
      await reportProxyBlocked(egress);
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
      await reportProxyBlocked(egress);
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
  const { abrasio, egress } = await startAbrasio(url, timeout, opts);
  try {
    return await fetchWithInstance(abrasio, url, timeout, opts, egress);
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
  private egress?: AbrasioEgress;
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
        const { abrasio, egress } = await startAbrasio(this.targetUrl, this.defaultTimeout, this.opts);
        this.egress = egress;
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
    return fetchWithInstance(abrasio, url, timeout ?? this.defaultTimeout, opts ?? this.opts, this.egress);
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
): Promise<{ page: any; close: () => Promise<void>; egress: AbrasioEgress; reportBlocked: () => Promise<void> }> {
  const { abrasio, egress } = await startAbrasio(url, timeout, opts);
  const page = await abrasio.newPage();
  return {
    page,
    egress,
    reportBlocked: () => reportProxyBlocked(egress),
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
