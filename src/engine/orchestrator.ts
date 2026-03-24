import { cheerioFetch } from "./cheerio-engine.js";
import { playwrightFetch, type PageAction } from "./playwright-engine.js";
import { abrasioFetch, isAbrasioAvailable, type AbrasioOptions, type AbrasioSession } from "./abrasio-engine.js";
import { isPdfUrl, fetchPdfAsMarkdown } from "../processors/pdf-parser.js";
import { AllLayersFailedError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface ExtractOptions {
  timeout?: number;
  forcePlaywright?: boolean;
  forceAbrasio?: boolean;
  actions?: PageAction[];
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  abrasio?: AbrasioOptions;
  /**
   * Shared Abrasio browser session. When provided, Layer 3 reuses this session
   * (opens a new tab) instead of creating a new browser instance.
   * Used by crawl jobs to keep a single browser alive across all pages.
   */
  abrasioSession?: AbrasioSession;
}

export interface ExtractResult {
  html: string;
  markdown?: string;
  statusCode: number;
  source: "cheerio" | "playwright" | "abrasio" | "pdf";
  metadata?: Record<string, unknown>;
  actionScreenshots?: string[];
}

/** Minimum visible text characters to consider a page as having real content. */
const MIN_CONTENT_CHARS = 200;

/**
 * Strips HTML tags and checks if a page has meaningful visible text.
 * Returns false for empty shells (JS-gated pages, anti-bot screens, blank responses).
 */
function hasContent(html: string): boolean {
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= MIN_CONTENT_CHARS;
}

/**
 * Calls Abrasio Layer 3 using either a shared session (crawl mode) or a
 * standalone browser (single request mode).
 */
async function callAbrasio(
  url: string,
  timeout: number,
  opts: ExtractOptions,
): Promise<{ html: string; markdown?: string; statusCode: number; metadata?: Record<string, unknown> }> {
  if (opts.abrasioSession) {
    return opts.abrasioSession.fetch(url, timeout, opts.abrasio);
  }
  return abrasioFetch(url, timeout, opts.abrasio);
}

/**
 * 3-layer extraction orchestrator.
 *
 * Layer 1: Cheerio (HTTP fetch, no browser) — fast, ~100ms
 * Layer 2: Patchright (headless browser) — handles JS-rendered content
 * Layer 3: Abrasio (stealth engine) — anti-bot bypass with fingerprint noise
 *
 * Falls through layers on exception OR when the returned HTML has no meaningful
 * content (empty shell, JS gate, silent anti-bot block).
 * Without Abrasio configured, stops at Patchright (open-source mode).
 */
export async function extract(url: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const timeout = opts.timeout ?? 60_000;
  const errors: string[] = [];
  const hasActions = opts.actions && opts.actions.length > 0;

  // PDF detection — handle PDF URLs directly without browser
  if (isPdfUrl(url)) {
    try {
      logger.debug("PDF URL detected, using PDF parser", { url });
      const pdf = await fetchPdfAsMarkdown(url, timeout);
      return {
        html: `<p>${pdf.markdown}</p>`,
        markdown: pdf.markdown,
        statusCode: 200,
        source: "pdf",
        metadata: { title: pdf.title, pageCount: pdf.pageCount },
      };
    } catch (err: any) {
      errors.push(`PDF: ${err.message}`);
      logger.debug("PDF parsing failed, falling through to standard extraction", { url, error: err.message });
    }
  }

  // Force-skip directly to Abrasio
  if (opts.forceAbrasio && isAbrasioAvailable()) {
    const result = await callAbrasio(url, timeout, opts);
    return { html: result.html, markdown: result.markdown, statusCode: result.statusCode, source: "abrasio", metadata: result.metadata };
  }

  // Layer 1: Cheerio (skip if forcePlaywright or if actions are specified — actions need a browser)
  if (!opts.forcePlaywright && !hasActions) {
    try {
      const result = await cheerioFetch(url, timeout);
      if (hasContent(result.html)) {
        return { html: result.html, statusCode: result.statusCode, source: "cheerio" };
      }
      errors.push("Cheerio: returned empty/thin content");
      logger.debug("Cheerio returned no meaningful content, falling through", { url });
    } catch (err: any) {
      errors.push(`Cheerio: ${err.message}`);
      logger.debug("Cheerio layer failed, falling through", { url, error: err.message });
    }
  }

  // Layer 2: Patchright (with optional page actions)
  try {
    const result = await playwrightFetch(url, {
      timeout,
      actions: opts.actions,
      waitUntil: opts.waitUntil,
      skipResourceBlocking: hasActions,
    });
    // When actions are specified we always trust the result (user controls the flow)
    if (hasActions || hasContent(result.html)) {
      return {
        html: result.html,
        statusCode: result.statusCode,
        source: "playwright",
        actionScreenshots: result.actionScreenshots,
      };
    }
    errors.push("Patchright: returned empty/thin content (silent block)");
    logger.debug("Patchright returned no meaningful content, falling through to Abrasio", { url });
  } catch (err: any) {
    errors.push(`Patchright: ${err.message}`);
    logger.debug("Patchright layer failed, falling through", { url, error: err.message });
  }

  // Layer 3: Abrasio (only if configured)
  if (isAbrasioAvailable()) {
    try {
      const result = await callAbrasio(url, timeout, opts);
      return { html: result.html, markdown: result.markdown, statusCode: result.statusCode, source: "abrasio", metadata: result.metadata };
    } catch (err: any) {
      errors.push(`Abrasio: ${err.message}`);
      logger.debug("Abrasio layer failed", { url, error: err.message });
    }
  }

  throw new AllLayersFailedError(url, errors);
}
