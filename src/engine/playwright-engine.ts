import { chromium, type BrowserContext, type Page } from "patchright";
import UserAgent from "user-agents";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { inferCountryFromUrl, getPlaywrightProxyForCountry } from "../utils/proxy-region.js";
import { channel } from "diagnostics_channel";

// ── Country-based browser pool ─────────────────────────────────────────────
// One persistent context per country (or "NONE" when proxy is not configured).
// Each context is launched with the country's proxy already embedded so that
// patchright stealth patches are applied in the correct IP/geo context.

const ctxPool = new Map<string, BrowserContext>();
const _launching = new Map<string, Promise<BrowserContext>>();

let activePagesCount = 0;

export function nextUserAgent(): string {
  return new UserAgent({ deviceCategory: "desktop" }).toString();
}
function _poolKey(country: string): string {
  if (!config.PROXY_URL || !config.PROXY_USERNAME || !config.PROXY_PASSWORD) return "NONE";
  return country.toUpperCase();
}

export async function getCtxForCountry(country: string): Promise<BrowserContext> {
  const key = _poolKey(country);

  if (ctxPool.has(key)) return ctxPool.get(key)!;
  if (_launching.has(key)) return _launching.get(key)!;

  const p = (async () => {
    const proxy = key !== "NONE" ? getPlaywrightProxyForCountry(key) : undefined;
    logger.info("Launching Playwright browser", { country: key });
    const ctx = await chromium.launchPersistentContext(
      `/tmp/patchright-${key.toLowerCase()}`,
      {
        headless: config.HEADLESS,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          ...(config.HEADLESS ? ["--disable-gpu"] : []),
        ],
        ignoreDefaultArgs: ["--enable-automation"],
        channel: "chrome",
        viewport: null,
        ...(proxy ? { proxy } : {}),
      },
    );
    ctxPool.set(key, ctx);
    _launching.delete(key);
    logger.info("Playwright browser launched", { country: key });
    return ctx;
  })();

  _launching.set(key, p);
  return p;
}

/**
 * Semaphore to limit concurrent Playwright pages.
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private current = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

const semaphore = new Semaphore(config.MAX_CONCURRENT_PAGES);


const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

const SOFT_BLOCK_TERMS = [
  "captcha",
  "cf-challenge",
  "hcaptcha",
  "recaptcha",
  "challenge-platform",
  "just a moment",
  "access denied",
];

// ── Page Actions ────────────────────────────────────────────────

export type PageAction =
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string }
  | { type: "wait"; milliseconds: number }
  | { type: "waitForSelector"; selector: string; timeout?: number }
  | { type: "scroll"; direction?: "down" | "up"; amount?: number }
  | { type: "scrollToBottom"; waitMs?: number; maxAttempts?: number }
  | { type: "screenshot" }
  | { type: "pressKey"; key: string }
  | { type: "select"; selector: string; value: string }
  | { type: "hover"; selector: string }
  | { type: "evaluate"; script: string };

export interface PlaywrightResult {
  html: string;
  statusCode: number;
  actionScreenshots?: string[];
}

/**
 * Pre-warm the default (BR) browser instance.
 * Country-specific browsers are launched on-demand on first request.
 */
export async function initPlaywright(): Promise<void> {
  await getCtxForCountry("BR");
}

/**
 * Close all browser instances in the pool.
 */
export async function closePlaywright(): Promise<void> {
  const entries = Array.from(ctxPool.entries());
  await Promise.allSettled(
    entries.map(async ([key, ctx]) => {
      await ctx.close().catch(() => {});
      logger.info("Playwright browser closed", { country: key });
    }),
  );
  ctxPool.clear();
}

/**
 * Execute a sequence of page actions (click, type, wait, scroll, etc.).
 * Returns any screenshots taken during actions.
 */
async function executeActions(page: Page, actions: PageAction[]): Promise<string[]> {
  const screenshots: string[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "click":
        await page.click(action.selector, { timeout: 10_000 });
        break;
      case "type":
        await page.fill(action.selector, action.text, { timeout: 10_000 });
        break;
      case "wait":
        await page.waitForTimeout(Math.min(action.milliseconds, 30_000));
        break;
      case "waitForSelector":
        await page.waitForSelector(action.selector, { timeout: action.timeout ?? 10_000 });
        break;
      case "scroll": {
        const amount = action.amount ?? 500;
        const dir = action.direction === "up" ? -amount : amount;
        await page.evaluate(`window.scrollBy(0, ${dir})`);
        await page.waitForTimeout(300);
        break;
      }
      case "scrollToBottom": {
        // Scroll to the real page bottom, repeating until the scroll height
        // stabilises (handles lazy-loaded lists, AJAX tables, infinite scroll).
        const waitMs = action.waitMs ?? 1500;
        const maxAttempts = action.maxAttempts ?? 10;
        let lastHeight = 0;
        let stableRounds = 0;
        for (let i = 0; i < maxAttempts; i++) {
          const currentHeight = (await page.evaluate("document.body.scrollHeight")) as number;
          await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
          await page.waitForTimeout(waitMs);
          if (currentHeight === lastHeight) {
            stableRounds++;
            if (stableRounds >= 2) break; // height unchanged for 2 consecutive checks
          } else {
            stableRounds = 0;
          }
          lastHeight = currentHeight;
        }
        break;
      }
      case "screenshot": {
        const buf = await page.screenshot({ fullPage: false, type: "png" });
        screenshots.push(buf.toString("base64"));
        break;
      }
      case "pressKey":
        await page.keyboard.press(action.key);
        break;
      case "select":
        await page.selectOption(action.selector, action.value, { timeout: 10_000 });
        break;
      case "hover":
        await page.hover(action.selector, { timeout: 10_000 });
        break;
      case "evaluate":
        await page.evaluate(action.script);
        break;
    }
  }

  return screenshots;
}

export interface PlaywrightFetchOptions {
  timeout?: number;
  actions?: PageAction[];
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  skipResourceBlocking?: boolean;
  /** Wait for this CSS selector to appear before extracting HTML. */
  waitForSelector?: string;
  /**
   * Explicit country code for proxy/browser selection (e.g. "US", "BR").
   * Falls back to TLD inference from the target URL when omitted.
   */
  country?: string;
  /** Extra HTTP headers set on every request made by this page. */
  headers?: Record<string, string>;
}

/**
 * Layer 2: Headless browser extraction via Playwright.
 * Handles JS-rendered pages, SPAs, and dynamic content.
 * Supports page actions (click, type, wait, scroll, etc.) before extraction.
 */
export async function playwrightFetch(
  url: string,
  optsOrTimeout: number | PlaywrightFetchOptions = {},
): Promise<PlaywrightResult> {
  // Backwards-compatible: accept a plain number as timeout
  const opts: PlaywrightFetchOptions =
    typeof optsOrTimeout === "number" ? { timeout: optsOrTimeout } : optsOrTimeout;
  const timeout = opts.timeout ?? 60_000;

  // Determine target country: explicit override > URL TLD inference
  const country = opts.country ?? inferCountryFromUrl(url);
  const persistCtx = await getCtxForCountry(country);

  await semaphore.acquire();
  activePagesCount++;

  let context: BrowserContext | null = null;

  try {
    // Get an isolated per-request context from the country-specific browser.
    // The proxy is also passed here so the isolated context routes correctly.
    const proxy = _poolKey(country) !== "NONE"
      ? getPlaywrightProxyForCountry(country)
      : undefined;

    context = await persistCtx.browser()!.newContext({
      //userAgent: ua.toString(),
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      ...(proxy ? { proxy } : {}),
    });

    const page = await context!.newPage();

    if (opts.headers && Object.keys(opts.headers).length > 0) {
      await page.setExtraHTTPHeaders(opts.headers);
    }

    // Block heavy resources for performance (unless actions need them)
    if (!opts.skipResourceBlocking) {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (BLOCKED_RESOURCES.has(type)) {
          return route.abort();
        }
        return route.continue();
      });
    }

    const response = await page.goto(url, {
      waitUntil: opts.waitUntil ?? "load",
      timeout,
    });

    const statusCode = response?.status() ?? 0;

    // Wait for a specific selector if requested (e.g. Google search results).
    // Falls through silently on timeout so extraction still runs.
    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, {
        timeout: Math.min(timeout, 10_000),
      }).catch(() => {});
    }

    // Extra settle time for JS-heavy pages
    await page.waitForTimeout(1500);

    // Execute page actions if provided
    let actionScreenshots: string[] | undefined;
    if (opts.actions && opts.actions.length > 0) {
      logger.debug("Executing page actions", { url, count: opts.actions.length });
      actionScreenshots = await executeActions(page, opts.actions);
      // Wait after actions for content to settle
      await page.waitForTimeout(500);
    }

    const html = await page.content();

    // Check for soft blocks
    const lower = html.toLowerCase();
    if (SOFT_BLOCK_TERMS.some((t) => lower.includes(t)) && html.length < 5000) {
      throw new Error(`Soft block detected (status: ${statusCode})`);
    }

    if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
      throw new Error(`Blocked with status ${statusCode}`);
    }

    logger.debug("Playwright fetch success", { url, status: statusCode, length: html.length });

    return {
      html,
      statusCode,
      actionScreenshots: actionScreenshots?.length ? actionScreenshots : undefined,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    activePagesCount--;
    semaphore.release();
  }
}

/**
 * Take a full-page screenshot.
 */
export async function takeScreenshot(
  url: string,
  opts: { fullPage?: boolean; type?: "png" | "jpeg"; timeout?: number; country?: string } = {},
): Promise<Buffer> {
  const country = opts.country ?? inferCountryFromUrl(url);
  const persistCtx = await getCtxForCountry(country);

  await semaphore.acquire();

  let context: BrowserContext | null = null;

  try {
    const proxy = _poolKey(country) !== "NONE"
      ? getPlaywrightProxyForCountry(country)
      : undefined;

    context = await persistCtx.browser()!.newContext({
      //userAgent: ua.toString(),
      viewport: { width: 1920, height: 1080 },
      ...(proxy ? { proxy } : {}),
    });

    const page = await context!.newPage();
    await page.goto(url, { waitUntil: "load", timeout: opts.timeout ?? 60_000 });
    // Allow JS-rendered content to settle before capturing
    await page.waitForTimeout(1500);

    const screenshot = await page.screenshot({
      fullPage: opts.fullPage ?? true,
      type: opts.type ?? "png",
    });

    return screenshot;
  } finally {
    if (context) await context.close().catch(() => {});
    semaphore.release();
  }
}
