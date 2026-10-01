import { Job } from "bullmq";
import { takeScreenshot, settlePage } from "../engine/playwright-engine.js";
import {
  isAbrasioAvailable, openAbrasioPersistentPage, isCaptchaPage, waitForCaptchaResolution,
} from "../engine/abrasio-engine.js";
import { looksBlocked, stripToVisibleText, MIN_CONTENT_CHARS } from "../utils/content-guard.js";
import { domainOf } from "../utils/domain-throttle.js";
import { isHardRouteDomain } from "../utils/hard-route.js";
import { EgressPolicyError } from "../utils/egress.js";
import { childLogger } from "../utils/logger.js";

export interface ScreenshotJobData {
  url: string;
  options?: {
    full_page?: boolean;
    type?: "png" | "jpeg";
    timeout?: number;
  };
}

export type ScreenshotBlockReason = "challenge" | "empty_page";

export interface ScreenshotJobResult {
  success: boolean;
  data: {
    url: string;
    screenshot: string; // base64
    type: string;
    /** Engine that produced the image. */
    engine: "playwright" | "abrasio";
    /**
     * true => the image shows a challenge/block page (or an empty shell), NOT the target
     * content. Clients must not store it as evidence. Lives inside `data` because the API
     * returns only `data` to the customer.
     */
    blocked: boolean;
    block_reason?: ScreenshotBlockReason;
    /** Real page with very little visible text (image/video post): kept, but flagged. */
    degraded?: boolean;
  };
  processing_time_ms: number;
}

/** Rendered DOM above this size with a title is a real page, even with little visible text. */
const SMALL_HTML_CHARS = 15_000;

/**
 * Same detection the extraction layers use (content-guard), adapted to images:
 *  - challenge: marker-gated anti-bot page => blocked;
 *  - little visible text: an image/video/gallery post legitimately has almost no text, so it
 *    only counts as blocked (`empty_page`) when the DOM is also small or has no <title>
 *    (an empty shell); otherwise it is just `degraded` (not blocked, no escalation).
 */
export function classifyCapture(html: string): { reason?: ScreenshotBlockReason; degraded?: boolean } {
  if (looksBlocked(html)) return { reason: "challenge" };
  if (stripToVisibleText(html).length >= MIN_CONTENT_CHARS) return {};
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  if (html.length < SMALL_HTML_CHARS || !title) return { reason: "empty_page" };
  return { degraded: true };
}

interface Shot {
  screenshot: Buffer;
  engine: "playwright" | "abrasio";
  reason?: ScreenshotBlockReason;
  degraded?: boolean;
}

// Share of the budget left for the escalation (session start + egress gate + navigation).
const ABRASIO_RESERVE_MS = 30_000;
const MIN_ESCALATION_MS = 8_000;

/** Abrasio capture bounded by the caller's real deadline (the API waits timeout + 15 s). */
async function abrasioShotWithin(
  url: string, deadline: number, fullPage: boolean, type: "png" | "jpeg",
): Promise<Shot> {
  const budget = deadline - Date.now();
  if (budget < MIN_ESCALATION_MS) throw new Error("no time left for the Abrasio escalation");
  const p = abrasioShot(url, budget, deadline, fullPage, type);
  p.catch(() => {}); // if the deadline wins, the session still closes itself in abrasioShot's finally
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Abrasio escalation exceeded the deadline")), budget);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function abrasioShot(
  url: string, timeoutMs: number, deadline: number, fullPage: boolean, type: "png" | "jpeg",
): Promise<Shot> {
  const handle = await openAbrasioPersistentPage(url, timeoutMs, { hard: isHardRouteDomain(domainOf(url)) || undefined });
  try {
    const page = handle.page;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await settlePage(page);
    // captcha wait only with what is left of the caller's deadline
    const left = deadline - Date.now() - 3_000;
    if (left > 2_000 && (await isCaptchaPage(page).catch(() => false))) {
      await waitForCaptchaResolution(page, url, left).catch(() => {});
    }
    const html: string = await page.content().catch(() => "");
    const c = classifyCapture(html);
    if (c.reason === "challenge") await handle.reportBlocked().catch(() => {});
    const screenshot: Buffer = await page.screenshot({ fullPage, type });
    return { screenshot, engine: "abrasio", ...c };
  } finally {
    await handle.close();
  }
}

export async function processScreenshotJob(job: Job<ScreenshotJobData>): Promise<ScreenshotJobResult> {
  const log = childLogger({ jobId: job.id, queue: "screenshot" });
  const start = Date.now();
  const { url, options = {} } = job.data;
  const fullPage = options.full_page ?? true;
  const type = options.type ?? "png";
  const timeoutMs = options.timeout ? options.timeout * 1000 : 60_000;
  const deadline = start + timeoutMs;
  const canEscalate = isAbrasioAvailable();
  const hard = isHardRouteDomain(domainOf(url));

  log.info("Screenshot started", { url, canEscalate, hard });

  let shot: Shot | undefined;
  let pwError: unknown;

  // Hard-route domains have no chance on the plain fleet (same rule as dataset/orchestrator).
  if (!(hard && canEscalate)) {
    // Leave room for the Abrasio escalation when it exists.
    const pwTimeout = canEscalate ? Math.max(10_000, Math.min(30_000, timeoutMs - ABRASIO_RESERVE_MS)) : timeoutMs;
    try {
      const cap = await takeScreenshot(url, { fullPage, type, timeout: pwTimeout });
      shot = { screenshot: cap.screenshot, engine: "playwright", ...classifyCapture(cap.html) };
    } catch (err) {
      if (err instanceof EgressPolicyError) throw err; // fail closed, never "try another way"
      pwError = err;
      log.warn("Playwright screenshot failed", { url, error: String(err).slice(0, 200) });
    }
  }

  if ((!shot || shot.reason) && canEscalate) {
    log.info("Escalating screenshot to Abrasio", { url, reason: shot?.reason ?? "playwright_error" });
    try {
      shot = await abrasioShotWithin(url, deadline, fullPage, type);
    } catch (err) {
      if (!shot) throw err; // nothing to return at all
      log.warn("Abrasio screenshot failed; returning the flagged Playwright capture", { url, error: String(err).slice(0, 200) });
    }
  }

  if (!shot) throw pwError ?? new Error("Screenshot failed");

  log.info("Screenshot completed", {
    url, engine: shot.engine, blocked: !!shot.reason, reason: shot.reason, size: shot.screenshot.length, ms: Date.now() - start,
  });

  return {
    success: true,
    data: {
      url,
      screenshot: shot.screenshot.toString("base64"),
      type: `image/${type}`,
      engine: shot.engine,
      blocked: !!shot.reason,
      ...(shot.reason ? { block_reason: shot.reason } : {}),
      ...(shot.degraded && !shot.reason ? { degraded: true } : {}),
    },
    processing_time_ms: Date.now() - start,
  };
}
