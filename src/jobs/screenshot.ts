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
  };
  processing_time_ms: number;
}

/** Same detection the extraction layers use (content-guard): marker-gated challenge, or no visible text. */
export function screenshotBlockReason(html: string): ScreenshotBlockReason | undefined {
  if (looksBlocked(html)) return "challenge";
  if (stripToVisibleText(html).length < MIN_CONTENT_CHARS) return "empty_page";
  return undefined;
}

interface Shot {
  screenshot: Buffer;
  engine: "playwright" | "abrasio";
  reason?: ScreenshotBlockReason;
}

const ABRASIO_MIN_BUDGET_MS = 30_000; // session start + egress readiness gate + navigation

async function abrasioShot(
  url: string, timeoutMs: number, fullPage: boolean, type: "png" | "jpeg",
): Promise<Shot> {
  const handle = await openAbrasioPersistentPage(url, timeoutMs, { hard: isHardRouteDomain(domainOf(url)) || undefined });
  try {
    const page = handle.page;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await settlePage(page);
    if (await isCaptchaPage(page).catch(() => false)) {
      await waitForCaptchaResolution(page, url, Math.min(60_000, timeoutMs)).catch(() => {});
    }
    const html: string = await page.content().catch(() => "");
    const reason = screenshotBlockReason(html);
    if (reason === "challenge") await handle.reportBlocked().catch(() => {});
    const screenshot: Buffer = await page.screenshot({ fullPage, type });
    return { screenshot, engine: "abrasio", reason };
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
    const pwTimeout = canEscalate ? Math.max(10_000, Math.min(30_000, timeoutMs - ABRASIO_MIN_BUDGET_MS)) : timeoutMs;
    try {
      const cap = await takeScreenshot(url, { fullPage, type, timeout: pwTimeout });
      shot = { screenshot: cap.screenshot, engine: "playwright", reason: screenshotBlockReason(cap.html) };
    } catch (err) {
      if (err instanceof EgressPolicyError) throw err; // fail closed, never "try another way"
      pwError = err;
      log.warn("Playwright screenshot failed", { url, error: String(err).slice(0, 200) });
    }
  }

  if ((!shot || shot.reason) && canEscalate) {
    log.info("Escalating screenshot to Abrasio", { url, reason: shot?.reason ?? "playwright_error" });
    try {
      shot = await abrasioShot(url, Math.max(ABRASIO_MIN_BUDGET_MS, deadline - Date.now()), fullPage, type);
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
    },
    processing_time_ms: Date.now() - start,
  };
}
