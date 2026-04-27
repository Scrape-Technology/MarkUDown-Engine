import { Job } from "bullmq";
import * as cheerio from "cheerio";
import { fetch } from "undici";
import { getCtxForCountry } from "../engine/playwright-engine.js";
import { isAbrasioAvailable, openAbrasioPersistentPage } from "../engine/abrasio-engine.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";
import { inferCountryFromUrl, getPlaywrightProxyForCountry } from "../utils/proxy-region.js";

interface FieldSelector {
  selector: string;
  attr: string | null;
}

interface SelectorPlan {
  item_container: string;
  fields: Record<string, FieldSelector>;
  pagination_next: string | null;
}

/**
 * Extract items from HTML using a pre-discovered SelectorPlan.
 * No network call — pure Cheerio. Returns [] if item_container matches nothing.
 */
function extractWithSelectors(html: string, plan: SelectorPlan): Record<string, unknown>[] {
  const $ = cheerio.load(html);
  const results: Record<string, unknown>[] = [];

  $(plan.item_container).each((_, el) => {
    const item: Record<string, unknown> = {};
    for (const [field, { selector, attr }] of Object.entries(plan.fields)) {
      const found = $(el).find(selector);
      if (found.length === 0) {
        item[field] = null;
      } else if (attr) {
        item[field] = found.first().attr(attr) || null;
      } else {
        item[field] = found.first().text().trim() || null;
      }
    }
    results.push(item);
  });

  return results;
}

/**
 * Call the Python LLM service to discover CSS selectors for a paginated list.
 * Receives raw HTML (not markdown) — selectors must map to HTML structure.
 * Returns null on any failure so callers can fall back to LLM extraction.
 */
async function discoverSelectors(
  url: string,
  html: string,
  goal: string,
  schema?: Record<string, string>,
): Promise<SelectorPlan | null> {
  try {
    const response = await fetch(`${config.PYTHON_LLM_URL}/discover-selectors/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        html,
        extract_query: goal,
        schema_fields: schema ?? undefined,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) return null;

    const result = (await response.json()) as {
      success: boolean;
      item_container: string;
      fields: Record<string, FieldSelector>;
      pagination_next: string | null;
    };

    if (!result.success || !result.item_container || !result.fields) return null;

    return {
      item_container: result.item_container,
      fields: result.fields,
      pagination_next: result.pagination_next,
    };
  } catch {
    return null;
  }
}

export interface DatasetJobData {
  url: string;
  goal: string;
  schema?: Record<string, string>;
  options?: {
    max_pages?: number;
    timeout?: number;
    output_format?: "json" | "csv";
  };
}

export interface DatasetJobResult {
  success: boolean;
  url: string;
  goal: string;
  total_records: number;
  pages_scraped: number;
  output_format: string;
  data: Record<string, unknown>[];
  processing_time_ms: number;
}

// Ordered list of CSS selectors to find the "next page" button/link.
// Tried in order — first match wins.
const NEXT_SELECTORS = [
  'link[rel="next"]',
  'a[rel="next"]',
  // aria-label patterns (EN + PT + ES)
  '[aria-label*="next" i]',
  '[aria-label*="próxim" i]',
  '[aria-label*="seguinte" i]',
  '[aria-label*="avançar" i]',
  // Text-content anchors — matched via custom logic below
  // CSS class patterns
  "a.next",
  "a.next-page",
  "a.pagination-next",
  "a.pager-next",
  "a.paginator-next",
  "a.page-next",
  "li.next > a",
  "li.next-page > a",
  "li.pager-next > a",
  "[class*='next-page'] a",
  "[class*='pagination-next'] a",
  // data-* attributes
  "[data-page-next]",
  "[data-next-page]",
  "[data-next-url]",
  "#rightArrow",
  "button#rightArrow"
];

// Text patterns for "next" anchors (anchor text matching)
const TEXT_NEXT_RE = /^(next|›|»|→|>|next\s*page|siguiente|próxima|próximo|avançar|seguinte|próxima\s*página|ir\s*para\s*próxima)$/i;

/**
 * Detect a CSS selector for the "next page" element from the current page HTML.
 * Returns the first matching selector string, or null if none found.
 * Does NOT validate href — next-page triggers are often JS onclick, not real links.
 */
function detectNextSelector(html: string): string | null {
  const $ = cheerio.load(html);
  for (const sel of NEXT_SELECTORS) {
    if ($(sel).first().length > 0) return sel;
  }
  return null;
}

async function extractPageItems(
  url: string,
  markdown: string,
  goal: string,
  schema?: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${config.PYTHON_LLM_URL}/extract/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      markdown,
      schema_fields: schema ?? undefined,
      extract_query: goal,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`LLM service returned ${response.status}`);
  }

  const result = (await response.json()) as {
    success: boolean;
    data: Record<string, unknown>[];
    total: number;
  };
  return result.data ?? [];
}

const BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

export async function processDatasetJob(job: Job<DatasetJobData>): Promise<DatasetJobResult> {
  const log = childLogger({ jobId: job.id, queue: "dataset" });
  const start = Date.now();
  const { url, goal, schema, options = {} } = job.data;
  const maxPages = options.max_pages ?? 10;
  const timeout = options.timeout ? options.timeout * 1000 : 60_000;
  const outputFormat = options.output_format ?? "json";

  log.info("Dataset extraction started", { url, goal, maxPages });

  const allData: Record<string, unknown>[] = [];
  let pagesScraped = 0;
  let selectorPlan: SelectorPlan | null = null;
  let consecutiveSelectorFailures = 0;

  // Browser setup: Abrasio stealth engine (if configured) → Patchright fallback.
  // Both return a Playwright-compatible page kept open across the full pagination loop.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;
  let closeBrowser: () => Promise<void>;

  if (isAbrasioAvailable()) {
    log.info("Dataset using Abrasio stealth browser");
    const abrasio = await openAbrasioPersistentPage(url, timeout);
    page = abrasio.page;
    closeBrowser = abrasio.close;
  } else {
    log.info("Dataset using Patchright browser");
    const country = inferCountryFromUrl(url);
    const persistCtx = await getCtxForCountry(country);
    const proxyConfig = (() => {
      try { return getPlaywrightProxyForCountry(country); } catch { return undefined; }
    })();
    const context = await persistCtx.browser()!.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });
    const pPage = await context.newPage();
    await pPage.route("**/*", (route: { request(): { resourceType(): string }; abort(): Promise<void>; continue(): Promise<void> }) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });
    page = pPage;
    closeBrowser = async () => {
      await pPage.close().catch(() => {});
      await context.close().catch(() => {});
    };
  }

  try {
    log.info("Navigating to initial URL", { url });
    await page.goto(url, { waitUntil: "load", timeout });

    while (pagesScraped < maxPages) {
      log.info("Extracting page", { page: pagesScraped + 1 });
      await job.updateProgress(Math.round((pagesScraped / maxPages) * 90));
      await page.waitForLoadState();
      const html = await page.content();
      const currentUrl = page.url();

      let pageData: Record<string, unknown>[] = [];
      let extractionFailed = false;

      if (pagesScraped === 0) {
        // Page 1: discover selectors via LLM, then extract with Cheerio
        log.info("Discovering selectors from page 1", { url: currentUrl });
        selectorPlan = await discoverSelectors(currentUrl, html, goal, schema);
        if (selectorPlan) {
          log.info("Selector plan discovered", {
            container: selectorPlan.item_container,
            fields: Object.keys(selectorPlan.fields),
            paginationNext: selectorPlan.pagination_next,
          });
          pageData = extractWithSelectors(html, selectorPlan);
        }
        // If discovery failed or selectors returned nothing, fall back to LLM.
        // Keep selectorPlan alive so pages 2+ can still try Cheerio — the plan
        // may be valid but page 1 rendered differently (lazy load, JS delay, etc.).
        // consecutiveSelectorFailures will abandon it if it keeps failing.
        if (pageData.length === 0) {
          log.info("Selector extraction empty on page 1, falling back to LLM (keeping plan for page 2+)");
          try {
            const cleaned = cleanHtml(html, currentUrl, { mainContent: true });
            // const markdown = await convertToMarkdown(cleaned.html);
            pageData = await extractPageItems(currentUrl, cleaned.html, goal, schema);
          } catch (err) {
            extractionFailed = true;
            log.warn("LLM extraction also failed on page 1", { error: String(err) });
          }
        }
      } else if (selectorPlan) {
        // Pages 2+: fast path — Cheerio only
        pageData = extractWithSelectors(html, selectorPlan);
        if (pageData.length === 0) {
          consecutiveSelectorFailures++;
          if (consecutiveSelectorFailures >= 2) {
            log.warn("Selector plan abandoned after consecutive failures", { page: pagesScraped + 1 });
            selectorPlan = null;
          }
          // Fall back to LLM for this page
          log.info("Cheerio returned 0 items, falling back to LLM for this page", { page: pagesScraped + 1 });
          try {
            const cleaned = cleanHtml(html, currentUrl, { mainContent: true });
            const markdown = await convertToMarkdown(cleaned.html);
            pageData = await extractPageItems(currentUrl, markdown, goal, schema);
          } catch (err) {
            extractionFailed = true;
            log.warn("LLM fallback also failed", { page: pagesScraped + 1, error: String(err) });
          }
        } else {
          consecutiveSelectorFailures = 0;
        }
      } else {
        // No selector plan (discovery failed on page 1): always use LLM
        try {
          const cleaned = cleanHtml(html, currentUrl, { mainContent: true });
          const markdown = await convertToMarkdown(cleaned.html);
          pageData = await extractPageItems(currentUrl, markdown, goal, schema);
        } catch (err) {
          extractionFailed = true;
          log.warn("LLM extraction failed for page, continuing to next", {
            page: pagesScraped + 1,
            error: String(err),
          });
        }
      }

      allData.push(...pageData);
      pagesScraped++;

      // Stop only when extraction succeeded but the page genuinely has no items
      if (!extractionFailed && pageData.length === 0) {
        log.info("No items on page, stopping pagination", { page: pagesScraped });
        break;
      }

      // Detect next-page element.
      // Priority: LLM-discovered pagination selector > static CSS list > Playwright text locator.
      let nextEl = null as Awaited<ReturnType<typeof page.$>> | null;
      let matchedVia = "";

      if (selectorPlan?.pagination_next) {
        nextEl = await page.$(selectorPlan.pagination_next);
        matchedVia = `discovered:${selectorPlan.pagination_next}`;
      }

      if (!nextEl) {
        const nextSel = detectNextSelector(html);
        if (nextSel) {
          nextEl = await page.$(nextSel);
          matchedVia = nextSel;
        }
      }

      if (!nextEl) {
        const textEl = page.locator("a, button").filter({ hasText: TEXT_NEXT_RE }).first();
        if (await textEl.count() > 0) {
          nextEl = await textEl.elementHandle();
          matchedVia = "text-match";
        }
      }

      if (!nextEl) {
        log.info("No next page button found, pagination complete", { page: pagesScraped });
        break;
      }

      log.info("Clicking next page", { via: matchedVia, page: pagesScraped + 1 });
      try {
        await nextEl.click();
      } catch {
        // Element may have been detached after an AJAX update; fall through to let
        // detectNextSelector re-find it on the next iteration or stop gracefully.
        log.info("Next element click failed (detached), stopping pagination", { via: matchedVia });
        break;
      }

      // Wait for new content to settle. networkidle covers both full navigation
      // and AJAX-loaded pagination. Falls back to domcontentloaded on timeout.
      try {
        await page.waitForLoadState("networkidle", { timeout: 15_000 });
      } catch {
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      }

      await page.waitForTimeout(500);
    }
  } finally {
    await closeBrowser();
  }

  await job.updateProgress(100);
  if (allData.length === 0 && pagesScraped > 0) {
    log.warn("Dataset job completed with 0 records — all pages failed extraction or returned empty", {
      url,
      pages: pagesScraped,
    });
  }
  log.info("Dataset extraction completed", {
    url,
    pages: pagesScraped,
    records: allData.length,
    ms: Date.now() - start,
  });

  return {
    success: true,
    url,
    goal,
    total_records: allData.length,
    pages_scraped: pagesScraped,
    output_format: outputFormat,
    data: allData,
    processing_time_ms: Date.now() - start,
  };
}
