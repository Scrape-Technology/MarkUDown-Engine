import { Job } from "bullmq";
import * as cheerio from "cheerio";
import { fetch } from "undici";
import { llmFetch } from "../utils/llm-fetch.js";
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
        // Attribute values don't concatenate meaningfully across elements
        // (two "src"/"href" values joined is garbage either way) — first
        // match is the reasonable choice here, unlike the text case below.
        item[field] = found.first().attr(attr) || null;
      } else {
        // `.text()` on a multi-element Cheerio set concatenates ALL matches
        // in document order — NOT `.first().text()`. Real markup routinely
        // splits one semantic value across sibling nodes with the same class
        // (currency symbol + amount as two <span>s is extremely common in
        // e-commerce price widgets); a selector broad enough to find the
        // value at all often matches every such sibling. Confirmed against
        // KaBuM's real listing markup (2026-08-19): price renders as
        // `<span class="...">R$</span><span class="...">289,99</span>`,
        // same class on both — `.first()` silently returned "R$" for every
        // item in the dataset, discarding the actual number entirely.
        item[field] = found.text().trim() || null;
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
    const response = await llmFetch("/discover-selectors/", {
      url,
      html,
      extract_query: goal,
      schema_fields: schema ?? undefined,
    }, 60_000);

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
  "button#rightArrow",
  // "Load more" buttons — these append to the same page rather than navigate,
  // but that's fine: the dedup logic in the main loop only keeps new items.
  "a.load-more",
  "button.load-more",
  "[data-load-more]",
  "[class*='load-more']",
  "[class*='carregar-mais']",
];

// Text patterns for "next" anchors (anchor text matching)
const TEXT_NEXT_RE = /^(next|›|»|→|>|next\s*page|siguiente|próxima|próximo|avançar|seguinte|próxima\s*página|ir\s*para\s*próxima|carregar\s*mais|ver\s*mais|mostrar\s*mais|load\s*more)$/i;

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

/**
 * Fallback pagination strategy for infinite-scroll listings that have no
 * clickable next-page element at all: scroll → extract whatever's in the DOM
 * right now → merge any new items into `allData` (dedup via `seenItemKeys`) →
 * repeat until nothing new turns up for several rounds in a row (or the time
 * budget runs out).
 *
 * Rewritten 2026-08-19, twice. First pass fixed the page-budget bug (see
 * below) but still used DOM ELEMENT COUNT as the growth signal — scroll,
 * recount `item_container` matches, keep going only while the count rises.
 * That's wrong for a real, confirmed case (ligapokemon.com.br, a 118-item
 * listing): the site virtualizes the list — items scrolled past get REMOVED
 * from the DOM as new ones mount, to keep the page light — so the count
 * hovers around the window size (~24) the whole time and never reads as
 * "growing." Result: 24 of 118 items collected, matching exactly what the
 * FIRST batch alone would produce, because the count-based version treated
 * "not growing" as "done" after the very first window and never extracted
 * again.
 *
 * The fix is the same shape the CEO described watching the page by hand:
 * scroll, then COLLECT (not "check if bigger, collect only once at the
 * end") — extract and dedup-merge after every single scroll step. This is
 * correct for both list shapes: a list that keeps appending DOM nodes just
 * yields mostly-duplicate extractions after the first few rounds (dedup
 * absorbs that for free); a virtualized list that swaps its window is where
 * this actually matters, since the union of everything ever seen across all
 * windows is the only way to recover all 118 items when no single DOM
 * snapshot ever contains more than ~24 of them.
 *
 * Also still fixes the original bug from the first rewrite: the caller
 * counts this whole scroll-and-collect session as ONE page toward
 * `maxPages`, not one per scroll tick — a 15-attempt/90s-total cap and a
 * "2 stable rounds and give up" threshold were burning the page budget on
 * internal scroll ticks instead of genuine navigations.
 *
 * Returns the number of new items merged into `allData`.
 */
async function scrollAndCollect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  plan: SelectorPlan,
  log: ReturnType<typeof childLogger>,
  budgetMs: number,
  allData: Record<string, unknown>[],
  seenItemKeys: Set<string>,
): Promise<number> {
  let stableRounds = 0;
  // 3, not 2: one stalled round is one slow XHR away from a false "done" —
  // require zero new items across several consecutive rounds, not just one.
  const REQUIRED_STABLE_ROUNDS = 3;
  const deadline = Date.now() + budgetMs;
  let totalNew = 0;

  while (Date.now() < deadline && stableRounds < REQUIRED_STABLE_ROUNDS) {
    // page.evaluate(string) runs inside the browser tab via Playwright's CDP
    // bridge — not Node's eval(). String form (not a typed function) because
    // this project's tsconfig has no "dom" lib; a function literal referencing
    // window/document fails type-checking here even though it only ever runs
    // in-browser. plan.item_container (an LLM-discovered CSS selector, not
    // caller/user input) is embedded via JSON.stringify — proper JS string-
    // literal escaping, not naive concatenation, so no injection risk even
    // from an adversarial value.
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    // Belt and suspenders: on sites whose real scroll container is a nested
    // `overflow` element rather than the document body, window.scrollTo is a
    // no-op and this is the only thing that actually reaches the lazy-load
    // trigger. Harmless when body IS the scroll container — scrollIntoView on
    // an element already in view does nothing.
    await page
      .evaluate(
        `(() => { const els = document.querySelectorAll(${JSON.stringify(plan.item_container)}); ` +
        `const last = els[els.length - 1]; if (last && last.scrollIntoView) last.scrollIntoView({ block: "end" }); })()`,
      )
      .catch(() => {});

    await page.waitForTimeout(1_000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 6_000 });
    } catch {
      // Some sites keep polling/websockets open and never go idle — ignore.
    }

    const html = await page.content();
    const items = extractWithSelectors(html, plan);
    let newThisRound = 0;
    for (const item of items) {
      const key = JSON.stringify(item);
      if (seenItemKeys.has(key)) continue;
      seenItemKeys.add(key);
      allData.push(item);
      newThisRound++;
    }

    if (newThisRound > 0) {
      totalNew += newThisRound;
      stableRounds = 0;
    } else {
      stableRounds++;
    }
  }

  log.info("Scroll-and-collect finished", {
    totalNew, timedOut: Date.now() >= deadline, stableRounds,
  });
  return totalNew;
}

async function extractPageItems(
  url: string,
  markdown: string,
  goal: string,
  schema?: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const response = await llmFetch("/extract/", {
    url,
    markdown,
    schema_fields: schema ?? undefined,
    extract_query: goal,
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

// Same signal the 3-layer orchestrator (orchestrator.ts) uses to decide a layer
// silently failed — duplicated locally because dataset.ts drives its own
// long-lived page instead of a single-shot orchestrator.extract() call, so it
// can't reuse that function directly.
//
// Extended 2026-08-19 with language-independent markers (cf-turnstile,
// challenges.cloudflare.com, ray id:) after a real Cloudflare Turnstile
// challenge (ligapokemon.com.br, pt-BR locale) slipped through both this check
// and orchestrator.ts's: its boilerplate ("Executando verificação de
// segurança"...) is 366 chars of visible text, clearing MIN_CONTENT_CHARS, and
// every old term here was English-only ("just a moment") so none matched the
// localized page. The result was accepted as real content and dataset
// extraction ran against the challenge page instead of the actual listing —
// 0 items, no error, no retry.
const MIN_CONTENT_CHARS = 200;
const SOFT_BLOCK_TERMS = [
  "captcha", "cf-challenge", "hcaptcha", "recaptcha", "challenge-platform", "just a moment", "access denied",
  "cf-turnstile", "challenges.cloudflare.com", "cf-chl-", "cf-please-wait", "ray id:", "/cdn-cgi/challenge-platform/",
];

function isThinOrBlocked(html: string): boolean {
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < MIN_CONTENT_CHARS) return true;
  const lower = html.toLowerCase();
  return SOFT_BLOCK_TERMS.some((t) => lower.includes(t)) && html.length < 5000;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openBrowserPage(url: string, timeout: number, useAbrasio: boolean): Promise<{ page: any; close: () => Promise<void> }> {
  if (useAbrasio) {
    const abrasio = await openAbrasioPersistentPage(url, timeout);
    return { page: abrasio.page, close: abrasio.close };
  }
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
  return {
    page: pPage,
    close: async () => {
      await pPage.close().catch(() => {});
      await context.close().catch(() => {});
    },
  };
}

export async function processDatasetJob(job: Job<DatasetJobData>): Promise<DatasetJobResult> {
  const log = childLogger({ jobId: job.id, queue: "dataset" });
  const start = Date.now();
  const { url, goal, schema, options = {} } = job.data;
  const maxPages = options.max_pages ?? 10;
  const timeout = options.timeout ? options.timeout * 1000 : 60_000;
  const outputFormat = options.output_format ?? "json";

  log.info("Dataset extraction started", { url, goal, maxPages });

  const allData: Record<string, unknown>[] = [];
  const seenItemKeys = new Set<string>();
  let pagesScraped = 0;
  let selectorPlan: SelectorPlan | null = null;
  let consecutiveSelectorFailures = 0;

  // Browser setup: Abrasio stealth engine (if configured) → Patchright otherwise.
  // Both return a Playwright-compatible page kept open across the full pagination loop.
  let usingAbrasio = isAbrasioAvailable();
  log.info(usingAbrasio ? "Dataset using Abrasio stealth browser" : "Dataset using Patchright browser");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;
  let closeBrowser: () => Promise<void>;
  ({ page, close: closeBrowser } = await openBrowserPage(url, timeout, usingAbrasio));

  try {
    log.info("Navigating to initial URL", { url });
    await page.goto(url, { waitUntil: "load", timeout });

    // Extra settle time before the very first extraction: page 1 feeds selector
    // discovery, and SPA listings often finish populating via XHR/JS after the
    // "load" event fires — grabbing HTML too early makes discovery see an empty
    // list and misdiagnose the page as having no items.
    await page.waitForTimeout(1500);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8_000 });
    } catch {
      // Pages with background polling/websockets never go idle — proceed anyway.
    }

    // If the engine we picked came back thin/blocked (captcha wall, anti-bot
    // interstitial, empty shell) and we haven't already paid for Abrasio, retry
    // once with the stealth engine — mirrors the escalation orchestrator.ts does
    // for /scrape, /crawl and /extract, adapted for a long-lived page instead of
    // a single fetch.
    if (!usingAbrasio && isAbrasioAvailable() && isThinOrBlocked(await page.content())) {
      log.warn("Patchright returned thin/blocked content on initial load, escalating to Abrasio", { url });
      await closeBrowser().catch(() => {});
      usingAbrasio = true;
      ({ page, close: closeBrowser } = await openBrowserPage(url, timeout, true));
      await page.goto(url, { waitUntil: "load", timeout });
      await page.waitForTimeout(1500);
      try {
        await page.waitForLoadState("networkidle", { timeout: 8_000 });
      } catch {
        // ignore
      }
    }

    if (isThinOrBlocked(await page.content())) {
      log.warn("Page still thin/blocked after engine selection, extraction will likely return few or no items", { url, usingAbrasio });
    }

    while (pagesScraped < maxPages) {
      log.info("Extracting page", { page: pagesScraped + 1 });
      await job.updateProgress(Math.round((pagesScraped / maxPages) * 90));
      // No args = state "load", default ~30s timeout, and — the actual bug —
      // no catch. Fine after a real page.goto(), but this runs on EVERY loop
      // iteration, including after infinite-scroll (tryScrollForMore) or a
      // "next" click that does a client-side route change (SPA soft nav):
      // neither re-fires a fresh "load" event, so this hung for the full 30s
      // and then threw UNCAUGHT, killing the whole job. Confirmed in
      // production: "page.waitForLoadState: Timeout 30000ms exceeded ...
      // domcontentloaded event fired" — domcontentloaded from the original
      // goto was the last thing Playwright ever saw; load never re-fired
      // because there was no new navigation to fire it.
      try {
        await page.waitForLoadState("load", { timeout: 8_000 });
      } catch {
        // Content is already there (scroll/soft-nav updates the DOM in
        // place) — proceeding without a fresh "load" is correct, not a
        // fallback of last resort.
      }
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

      // Dedup before appending. Click-based pagination lands on a fresh page each
      // time (no overlap, every item is "new"). Infinite-scroll/"load more" grows
      // the SAME page instead of navigating, so re-extracting after a scroll
      // returns the old items again alongside the new ones — without this, those
      // would be double-counted every scroll round.
      const newItems = pageData.filter((item) => {
        const key = JSON.stringify(item);
        if (seenItemKeys.has(key)) return false;
        seenItemKeys.add(key);
        return true;
      });
      allData.push(...newItems);
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
        // No clickable next-page control anywhere on the page. Before giving up,
        // scroll and collect: sites like listing/marketplace pages often append
        // — or, as confirmed on a real 118-item ligapokemon.com.br listing,
        // VIRTUALIZE (swap, not append) — more items on scroll with no "next"
        // element to find in the first place. Extraction happens after every
        // scroll step inside scrollAndCollect (not once at the end — a
        // virtualized list never has more than one window's worth in the DOM
        // at a time, so a single final snapshot would miss everything outside
        // the last window). Budget is tied to the job's own declared timeout
        // (bounded 30s–120s), so a caller who asked for more patience via
        // `timeout` actually gets it here. Counts as ONE page toward
        // `maxPages` regardless of how many scroll ticks it took.
        if (selectorPlan) {
          const scrollBudgetMs = Math.max(30_000, Math.min(120_000, timeout));
          const newItems = await scrollAndCollect(
            page, selectorPlan, log, scrollBudgetMs, allData, seenItemKeys,
          );
          if (newItems > 0) {
            pagesScraped++;
            log.info("Infinite-scroll collection complete", {
              newItems, totalItems: allData.length,
            });
            break;
          }
        }
        log.info("No next page button found and scroll produced no new items, pagination complete", { page: pagesScraped });
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
