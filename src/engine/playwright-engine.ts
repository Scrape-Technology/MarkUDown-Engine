import { chromium, type Browser, type BrowserContext, type Page } from "patchright";
import UserAgent from "user-agents";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { getPlaywrightProxyForUrl } from "../utils/proxy-region.js";

let browser: Browser | null = null;
let activePagesCount = 0;

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
 * Initialize the shared Playwright browser instance.
 */
export async function initPlaywright(): Promise<void> {
  if (browser) return;
  logger.info("Launching Playwright browser...");
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  logger.info("Playwright browser launched");
}

/**
 * Close the shared browser.
 */
export async function closePlaywright(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info("Playwright browser closed");
  }
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

  if (!browser) await initPlaywright();

  await semaphore.acquire();
  activePagesCount++;

  let context: BrowserContext | null = null;

  try {
    const ua = new UserAgent({ deviceCategory: "desktop" });

    const proxy = getPlaywrightProxyForUrl(url);
    context = await browser!.newContext({
      userAgent: ua.toString(),
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      ...(proxy ? { proxy } : {}),
    });

    const page = await context.newPage();

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
      waitUntil: opts.waitUntil ?? "networkidle",
      timeout,
    });

    const statusCode = response?.status() ?? 0;

    // Wait a bit for JS to render
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
  opts: { fullPage?: boolean; type?: "png" | "jpeg"; timeout?: number } = {},
): Promise<Buffer> {
  if (!browser) await initPlaywright();

  await semaphore.acquire();

  let context: BrowserContext | null = null;

  try {
    const ua = new UserAgent({ deviceCategory: "desktop" });
    const proxy = getPlaywrightProxyForUrl(url);
    context = await browser!.newContext({
      userAgent: ua.toString(),
      viewport: { width: 1920, height: 1080 },
      ...(proxy ? { proxy } : {}),
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeout ?? 60_000 });

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
