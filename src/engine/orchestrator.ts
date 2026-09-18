import { cheerioFetch, loadCheerio } from "./cheerio-engine.js";
import { playwrightFetch, type PageAction } from "./playwright-engine.js";
import { abrasioFetch, isAbrasioAvailable, type AbrasioOptions, type AbrasioSession } from "./abrasio-engine.js";
import { isPdfUrl, fetchPdfAsMarkdown } from "../processors/pdf-parser.js";
import { AllLayersFailedError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { hasContent } from "../utils/content-guard.js";

export interface ExtractOptions {
  timeout?: number;
  forcePlaywright?: boolean;
  forceAbrasio?: boolean;
  actions?: PageAction[];
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  /** Wait for this CSS selector before extracting HTML (Layer 2 only). */
  waitForSelector?: string;
  /**
   * Explicit country code for proxy/browser selection (e.g. "US", "BR").
   * Falls back to TLD inference from the target URL when omitted.
   */
  country?: string;
  /** Extra HTTP headers forwarded to the Playwright page (Layer 2 only). */
  headers?: Record<string, string>;
  abrasio?: AbrasioOptions;
  /**
   * Shared Abrasio browser session. When provided, Layer 3 reuses this session
   * (opens a new tab) instead of creating a new browser instance.
   * Used by crawl jobs to keep a single browser alive across all pages.
   */
  abrasioSession?: AbrasioSession;
  /**
   * Validate that the returned HTML actually contains the data the caller
   * needs, not just "isn't a block page" — checked at EVERY layer, including
   * Layer 3. content-guard.ts's hasContent()/looksBlocked() only answer "is
   * this a captcha/empty-shell page?"; a page can pass that check with status
   * 200 and a normal-sized body while still missing the one thing the caller
   * actually wanted (e.g. a price rendered client-side by JS that never
   * reaches Layer 1's server-rendered HTML at all). Confirmed live 2026-09-18
   * against marisa.com.br: Layer 1 returned a "successful" 518KB page whose
   * only currency-looking text was an empty cart's "R$ 0,00" subtotal — the
   * real price (R$59,95 / R$39,99) only exists after JS renders it, so it
   * silently never escalated past Layer 1 without this.
   *
   * `selector` and `pattern` are OR'd internally per-condition (both must
   * match if both given). If not one of the two is satisfied, the layer's
   * result is treated as incomplete — same escalation path as
   * `waitForSelector`'s `selectorFound === false` — and extraction moves to
   * the next layer. If even Layer 3 (or the forced layer) fails the
   * requirement, `extract()` throws AllLayersFailedError instead of silently
   * returning a "successful" response missing the requested data.
   */
  requireContent?: {
    /** CSS selector that must match at least one element in the returned HTML. */
    selector?: string;
    /** Regex that must match somewhere in the returned HTML. */
    pattern?: RegExp;
  };
}

/**
 * True when `html` satisfies an optional ExtractOptions.requireContent check.
 * No requirement given => always true (opt-in feature, zero effect on
 * existing callers that don't set it).
 */
function satisfiesContentRequirement(html: string, requirement: ExtractOptions["requireContent"]): boolean {
  if (!requirement) return true;
  if (requirement.selector) {
    const $ = loadCheerio(html);
    if ($(requirement.selector).length === 0) return false;
  }
  if (requirement.pattern) {
    if (!requirement.pattern.test(html)) return false;
  }
  return true;
}

export interface ExtractResult {
  html: string;
  markdown?: string;
  statusCode: number;
  source: "cheerio" | "playwright" | "abrasio" | "pdf";
  metadata?: Record<string, unknown>;
  actionScreenshots?: string[];
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
 * Falls through layers on exception, when the returned HTML has no meaningful
 * content (empty shell, JS gate, silent anti-bot block), or — when the caller
 * passed `requireContent` — when the specific data asked for isn't actually
 * present (e.g. Layer 1's server-rendered HTML looks fine but the caller's
 * price selector/pattern never matches because the real price only exists
 * after client-side JS runs). Without Abrasio configured, stops at Patchright
 * (open-source mode).
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
    if (!satisfiesContentRequirement(result.html, opts.requireContent)) {
      throw new AllLayersFailedError(url, ["Abrasio (forced): returned content missing requireContent match"]);
    }
    return { html: result.html, markdown: result.markdown, statusCode: result.statusCode, source: "abrasio", metadata: result.metadata };
  }

  // Layer 1: Cheerio (skip if forcePlaywright or if actions are specified — actions need a browser)
  if (!opts.forcePlaywright && !hasActions) {
    try {
      const result = await cheerioFetch(url, timeout);
      if (hasContent(result.html) && satisfiesContentRequirement(result.html, opts.requireContent)) {
        return { html: result.html, statusCode: result.statusCode, source: "cheerio" };
      }
      errors.push(
        hasContent(result.html)
          ? "Cheerio: content present but missing requireContent match"
          : "Cheerio: returned empty/thin content",
      );
      logger.debug("Cheerio returned no meaningful/required content, falling through", { url });
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
      waitForSelector: opts.waitForSelector,
      skipResourceBlocking: hasActions,
      country: opts.country,
      headers: opts.headers,
    });
    // When actions are specified we always trust the result (user controls the flow).
    // `selectorFound === false` means the caller asked for a specific element (e.g. a
    // price/product selector) and it never appeared — treat that as thin content even
    // when there's enough surrounding page chrome to pass the generic text check, so
    // a page that never rendered the thing being asked for doesn't come back as "success".
    // requireContent is checked regardless of hasActions — it's an explicit ask from
    // the caller, not something a page-action script implicitly satisfies.
    const passesPageCheck = hasActions || (hasContent(result.html) && result.selectorFound !== false);
    if (passesPageCheck && satisfiesContentRequirement(result.html, opts.requireContent)) {
      return {
        html: result.html,
        statusCode: result.statusCode,
        source: "playwright",
        actionScreenshots: result.actionScreenshots,
      };
    }
    errors.push(
      !passesPageCheck
        ? result.selectorFound === false
          ? "Patchright: requested selector never appeared (thin/wrong content)"
          : "Patchright: returned empty/thin content (silent block)"
        : "Patchright: content present but missing requireContent match",
    );
    logger.debug("Patchright returned no meaningful/required content, falling through to Abrasio", { url });
  } catch (err: any) {
    errors.push(`Patchright: ${err.message}`);
    logger.debug("Patchright layer failed, falling through", { url, error: err.message });
  }

  // Layer 3: Abrasio (only if configured) — last layer, so a requireContent
  // miss here has nowhere left to escalate to: fail loudly (AllLayersFailedError)
  // rather than silently return a "successful" response missing the data the
  // caller explicitly asked to validate.
  if (isAbrasioAvailable()) {
    try {
      const result = await callAbrasio(url, timeout, opts);
      if (satisfiesContentRequirement(result.html, opts.requireContent)) {
        return { html: result.html, markdown: result.markdown, statusCode: result.statusCode, source: "abrasio", metadata: result.metadata };
      }
      errors.push("Abrasio: content present but missing requireContent match");
      logger.debug("Abrasio returned content but requireContent never matched", { url });
    } catch (err: any) {
      errors.push(`Abrasio: ${err.message}`);
      logger.debug("Abrasio layer failed", { url, error: err.message });
    }
  }

  throw new AllLayersFailedError(url, errors);
}
