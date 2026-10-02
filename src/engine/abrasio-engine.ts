import { Abrasio, AbrasioError, BlockedError, TimeoutError } from "abrasio-sdk";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { EgressPolicyError, abrasioEgressFor, type AbrasioEgress } from "../utils/egress.js";
import { capDomain, countIspNavigation, markIpBlocked, refundIspUnits } from "../utils/proxy-pool.js";
import { forbiddenEgressList } from "../utils/self-ip.js";

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
  /** Navegações planejadas na sessão (ex. max_pages do dataset): reservadas no teto do IP ISP. */
  navigations?: number;
  /** Epoch ms after which no NEW session is attempted (the caller's job time budget). */
  deadline?: number;
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

// Eco de IP, em rodízio por tentativa: se um serviço cair/bloquear, o próximo é tentado.
export const IP_ECHO_URLS = ["https://api.ipify.org?format=json", "https://ifconfig.me/ip", "https://checkip.amazonaws.com"];
export const READINESS_BUDGET_MS = 20_000;

/**
 * Failure of the readiness gate of a session that DID start (tunnel never up, wrong/forbidden
 * exit IP) — as opposed to an EgressPolicyError from abrasioEgressFor (no approved proxy / hard
 * pool denied), which no fallback may route around.
 */
export class EgressGateError extends EgressPolicyError {}
/** The echoed exit IP is known and wrong (not the ISP host / forbidden) — unlike a tunnel timeout. */
export class EgressIpMismatchError extends EgressGateError {}
/**
 * The echoed exit IP is forbidden (this machine / home / NAT) or unverifiable (IPv6 vs an
 * IPv4-only list): the WORKER did not apply the proxy — not the ISP's fault, so no cooldown.
 */
export class EgressForbiddenIpError extends EgressGateError {}

/** Texto do eco (JSON `{"ip":..}` ou IP puro) => IP, ou undefined se não parecer um IP. */
export function parseEchoIp(text: string): string | undefined {
  const t = text.trim();
  const ip = t.startsWith("{") ? JSON.parse(t)?.ip : t;
  return typeof ip === "string" && (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]+:[0-9a-f:]*$/i.test(ip)) ? ip : undefined;
}

function ipv4ToInt(ip: string): number | undefined {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** True se `ip` está na lista CSV de IPs/CIDRs IPv4 (EGRESS_FORBIDDEN_IPS). IPv6: igualdade exata. */
export function ipInList(ip: string, csv: string): boolean {
  return csv.split(/[,;\s]+/).filter(Boolean).some((entry) => {
    const [base, bitsStr] = entry.split("/");
    if (bitsStr === undefined) return base.toLowerCase() === ip.toLowerCase();
    const a = ipv4ToInt(ip), b = ipv4ToInt(base), bits = Number(bitsStr);
    if (a === undefined || b === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

/**
 * Readiness gate: after the session is created with a proxy and BEFORE navigating to the
 * target, prove the proxy tunnel is up with a short IP-echo navigation (which exits through the
 * proxy), retrying up to READINESS_BUDGET_MS across IP_ECHO_URLS. The echoed IP must not be in
 * EGRESS_FORBIDDEN_IPS (home IP, ECS NAT…) and, for a static ISP proxy, must equal the proxy
 * host (proof of egress). Never resolves => EgressPolicyError; wrong IP => EgressIpMismatchError.
 */
export async function assertProxyReady(abrasio: Abrasio, egress: AbrasioEgress): Promise<string | undefined> {
  if (!egress.proxy || !config.PROXY_READINESS_GATE) return undefined;
  const deadline = Date.now() + READINESS_BUDGET_MS;
  let ip: string | undefined;
  let lastErr = "";
  for (let i = 0; !ip && Date.now() < deadline; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any;
    try {
      page = await abrasio.newPage();
      await page.goto(IP_ECHO_URLS[i % IP_ECHO_URLS.length], { waitUntil: "domcontentloaded", timeout: Math.max(3_000, Math.min(8_000, deadline - Date.now())) });
      ip = parseEchoIp(String(await page.evaluate("document.body.innerText")));
      if (!ip) throw new Error("resposta do eco não é um IP");
    } catch (e) {
      lastErr = String(e).slice(0, 120);
      await new Promise((r) => setTimeout(r, 1_000));
    } finally {
      await Promise.resolve(page?.close?.()).catch(() => {});
    }
  }
  if (!ip) {
    throw new EgressGateError(
      `Egress bloqueado (fail-closed): o túnel do proxy ${egress.label} não ficou pronto em ${READINESS_BUDGET_MS / 1000}s (${lastErr}).`,
    );
  }
  const forbidden = await forbiddenEgressList(config.EGRESS_FORBIDDEN_IPS);
  if (ip.includes(":") && forbidden.trim() && !forbidden.includes(":")) {
    // IPv6 exit but the forbidden list (incl. the self IP from an IPv4 echo) only knows IPv4:
    // we cannot prove it is not this machine's own IPv6.
    throw new EgressForbiddenIpError(
      `Egress bloqueado (fail-closed): IP de saída IPv6 ${ip} não verificável (lista de IPs proibidos só tem IPv4) — proxy ${egress.label}.`,
    );
  }
  if (ipInList(ip, forbidden)) {
    throw new EgressForbiddenIpError(
      `Egress bloqueado (fail-closed): IP de saída ${ip} é um IP proibido (EGRESS_FORBIDDEN_IPS / IP próprio do worker) — o proxy ${egress.label} não foi aplicado.`,
    );
  }
  if (egress.ispIp && ip !== egress.ispIp) {
    throw new EgressIpMismatchError(
      `Egress bloqueado (fail-closed): IP de saída ${ip} difere do IP do proxy ISP ${egress.label} — o proxy não foi aplicado.`,
    );
  }
  logger.info("Abrasio proxy ready", { pool: egress.pool ?? "explicit", proxy: egress.label, exitIp: ip });
  return ip;
}

/**
 * Creates + starts an Abrasio session and runs the readiness gate, with ONE retry on a fresh
 * session when either step fails (the ISP cap reservation is always refunded). A static ISP
 * proxy that PROVABLY did not apply (exit IP mismatch) goes into cooldown first, so the retry
 * re-resolves to another ISP IP or Geonode; a Geonode sticky retry gets a
 * new session id => new exit IP. Measured 2026-09-30: of 3 concurrent sessions, one never
 * became ready (cloud side, 60 s) and one had a dead residential tunnel (gate, 20 s) — each
 * failed the whole job although a second session is usually fine. Still fail-closed: the
 * retry goes through the same policy, and a second failure propagates.
 */
async function startAbrasio(url: string, timeout: number, opts: AbrasioOptions): Promise<{ abrasio: Abrasio; egress: AbrasioEgress }> {
  for (let attempt = 1; ; attempt++) {
    const { cfg, egress } = await buildAbrasioConfig(url, timeout, opts);
    const abrasio = new Abrasio(cfg);
    try {
      await abrasio.start();
      await assertProxyReady(abrasio, egress);
      return { abrasio, egress };
    } catch (err) {
      await abrasio.close().catch(() => {});
      await refundReservation(egress); // never navigated to the target
      if (attempt === 1 && (opts.deadline === undefined || Date.now() < opts.deadline)) {
        // Cooldown só com prova de IP errado (EgressIpMismatchError); timeout do túnel/start pode
        // ser transitório e IP proibido não é culpa do ISP — esses só re-tentam numa sessão nova.
        if (egress.ispIp && err instanceof EgressIpMismatchError) await markIpBlocked(egress.ispIp);
        logger.warn("Abrasio session failed to start/become ready, retrying once on a fresh session", {
          proxy: egress.label, error: String(err).slice(0, 160),
        });
        continue;
      }
      throw err;
    }
  }
}

/** Give back `units` (default: all) of the ISP cap reserved for this session. */
async function refundReservation(egress: AbrasioEgress, units?: number): Promise<void> {
  const r = egress.ispReservation;
  if (!egress.ispIp || !r) return;
  await refundIspUnits(egress.ispIp, r.domain, Math.min(r.units, units ?? r.units)).catch(() => {});
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
      try {
        await waitForCaptchaResolution(page, url);
      } catch (e) {
        await reportProxyBlocked(egress); // só queima o IP se o captcha NÃO foi resolvido
        throw e;
      }
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
  private navigations = 0;

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
    // O teto do IP ISP conta navegações: a 1ª foi reservada no pickIsp, as demais entram aqui.
    if (this.navigations++ > 0 && this.egress?.ispIp) await countIspNavigation(this.egress.ispIp, capDomain(url));
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
): Promise<{ page: any; close: (usedNavigations?: number) => Promise<void>; egress: AbrasioEgress; reportBlocked: () => Promise<void> }> {
  const { abrasio, egress } = await startAbrasio(url, timeout, opts);
  const page = await abrasio.newPage();
  let closed = false;
  return {
    page,
    egress,
    reportBlocked: () => reportProxyBlocked(egress),
    /** `usedNavigations` (when known) refunds the unused part of the ISP cap reservation. */
    close: async (usedNavigations?: number) => {
      await page.close().catch(() => {});
      await abrasio.close().catch(() => {});
      if (closed) return;
      closed = true;
      const reserved = egress.ispReservation?.units ?? 0;
      if (usedNavigations !== undefined && reserved > usedNavigations) {
        await refundReservation(egress, reserved - Math.max(0, usedNavigations));
      }
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
