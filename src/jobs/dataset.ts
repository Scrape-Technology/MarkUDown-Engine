import { Job } from "bullmq";
import * as cheerio from "cheerio";
import { llmFetch } from "../utils/llm-fetch.js";
import { getCtxForCountry } from "../engine/playwright-engine.js";
import { isAbrasioAvailable, openAbrasioPersistentPage, isCaptchaPage, waitForCaptchaResolution } from "../engine/abrasio-engine.js";
import { cheerioFetch, type CheerioGeo } from "../engine/cheerio-engine.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";
import { playwrightProxyFor } from "../utils/egress.js";
import { inferCountryFromUrl, getApprovedProxy, normalizeCity } from "../utils/proxy-region.js";
import { hasContent } from "../utils/content-guard.js";
import { domainOf } from "../utils/domain-throttle.js";
import { isHardRouteDomain } from "../utils/hard-route.js";
import {
  extractWithSelectors, assessPlanQuality, absolutizeLinkFields, normalizeCountry,
  type FieldSelector, type SelectorPlan,
} from "./dataset-extract.js";

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

/**
 * Discover a plan on page 1, extract, and gate the result. A plan that "works"
 * (items > 0) but whose link field is empty / one repeated value is worse than
 * no plan: it is reported as success with garbage. Rejected once -> regenerate
 * the plan once (the LLM is not deterministic: Amazon gave 60 URLs on one run,
 * 60 empties on the next) -> still bad -> return no plan so the caller falls
 * back to the LLM over the page content.
 */
async function discoverValidatedPlan(
  currentUrl: string,
  html: string,
  goal: string,
  schema: Record<string, string> | undefined,
  log: ReturnType<typeof childLogger>,
): Promise<{ plan: SelectorPlan | null; items: Record<string, unknown>[] }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const plan = await discoverSelectors(currentUrl, html, goal, schema);
    if (!plan) return { plan: null, items: [] };
    const items = extractWithSelectors(html, plan, currentUrl);
    if (items.length === 0) return { plan, items }; // existing empty-page handling applies
    const verdict = assessPlanQuality(items, schema, plan);
    if (verdict.valid) return { plan, items };
    log.warn("Selector plan rejected by quality gate", {
      attempt, reason: verdict.reason, container: plan.item_container, items: items.length,
    });
  }
  log.warn("Selector plan rejected twice, falling back to LLM extraction over page content");
  return { plan: null, items: [] };
}

export interface DatasetJobData {
  url: string;
  goal: string;
  schema?: Record<string, string>;
  options?: {
    max_pages?: number;
    timeout?: number;
    output_format?: "json" | "csv";
    /** ISO 3166-1 alpha-2 (e.g. "BR"): forces the exit country of proxy/browser/Abrasio instead of inferring it from the URL's TLD. */
    country?: string;
    /** Lowercase ascii city slug (e.g. "saopaulo"); needs `country`. Targets the residential proxy at that city. */
    city?: string;
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
    const items = extractWithSelectors(html, plan, typeof page.url === "function" ? page.url() : undefined);
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
/** Inverse of the shared `hasContent()` guard — kept as a local alias since every call
 * site here reads more naturally as "is this thin/blocked" than "does it have content". */
function isThinOrBlocked(html: string): boolean {
  return !hasContent(html);
}

/**
 * Resolve the next-page URL purely from static HTML — same selector
 * priority as the browser loop below (discovered plan > static CSS list >
 * text match), but reading `href` directly instead of clicking, since
 * there's no live page here to click on. Returns null when the matched
 * element (if any) has no real href: that's the signal pagination needs JS
 * or interactivity (an onclick handler, an infinite-scroll trigger),  and
 * Cheerio genuinely cannot go further — not a retry case, a hard wall.
 */
function resolveNextUrlFromHtml(html: string, currentUrl: string, plan: SelectorPlan | null): string | null {
  const $ = cheerio.load(html);
  const candidates = [plan?.pagination_next, detectNextSelector(html)].filter(
    (s): s is string => Boolean(s),
  );

  for (const sel of candidates) {
    const href = $(sel).first().attr("href");
    if (href) {
      try { return new URL(href, currentUrl).toString(); } catch { /* malformed — try next candidate */ }
    }
  }

  let textHref: string | undefined;
  $("a").each((_, el) => {
    if (textHref) return;
    if (TEXT_NEXT_RE.test($(el).text().trim())) textHref = $(el).attr("href");
  });
  if (textHref) {
    try { return new URL(textHref, currentUrl).toString(); } catch { return null; }
  }

  return null;
}

interface CheerioPathResult {
  allData: Record<string, unknown>[];
  seenItemKeys: Set<string>;
  selectorPlan: SelectorPlan | null;
  pagesScraped: number;
  /** True when Cheerio alone paginated to genuine exhaustion (no next link
   * found, or maxPages reached while still finding real content) — the
   * caller can return this result directly, no browser needed at all. */
  exhausted: boolean;
}

/**
 * Layer 1 of the ladder: plain HTTP + Cheerio, proxied via
 * getProxyAgentForUrl (cheerioFetch already applies it — same mechanism
 * orchestrator.ts's Layer 1 uses for /scrape, /extract, /crawl). No browser
 * at all: fast (~100ms/page), cheap, and correct for the large share of
 * listings that are plain server-rendered HTML with real <a href>
 * pagination — paying full browser overhead (Patchright launch, or an
 * Abrasio cloud session) unconditionally on every dataset job, as this one
 * did before, was wasted cost on every call that didn't strictly need it.
 *
 * Hands off to the browser ladder below (returns with exhausted:false) the
 * moment any of these happens:
 *   - a fetch is blocked/thin (cheerioFetch throws, or isThinOrBlocked)
 *   - no selector plan could be discovered from static HTML, and the LLM
 *     fallback (same one the browser loop uses) also finds nothing on page 1
 *   - a later page's fetch fails or looks blocked
 *   - the "next" control has no real href — Cheerio cannot click or scroll
 */
async function tryCheerioPath(
  url: string,
  goal: string,
  schema: Record<string, string> | undefined,
  maxPages: number,
  timeout: number,
  log: ReturnType<typeof childLogger>,
  geo: CheerioGeo = {},
): Promise<CheerioPathResult> {
  const allData: Record<string, unknown>[] = [];
  const seenItemKeys = new Set<string>();
  let selectorPlan: SelectorPlan | null = null;
  let pagesScraped = 0;
  let currentUrl = url;

  const mergeNew = (items: Record<string, unknown>[]): void => {
    for (const item of items) {
      const key = JSON.stringify(item);
      if (seenItemKeys.has(key)) continue;
      seenItemKeys.add(key);
      allData.push(item);
    }
  };

  while (pagesScraped < maxPages) {
    let html: string;
    try {
      html = (await cheerioFetch(currentUrl, timeout, geo)).html;
    } catch (err) {
      log.info("Cheerio layer failed, handing off to browser", { url: currentUrl, error: String(err) });
      return { allData, seenItemKeys, selectorPlan, pagesScraped, exhausted: false };
    }

    if (isThinOrBlocked(html)) {
      log.info("Cheerio layer returned thin/blocked content, handing off to browser", { url: currentUrl });
      return { allData, seenItemKeys, selectorPlan, pagesScraped, exhausted: false };
    }

    let pageData: Record<string, unknown>[];
    if (pagesScraped === 0) {
      ({ plan: selectorPlan, items: pageData } = await discoverValidatedPlan(currentUrl, html, goal, schema, log));
      if (pageData.length === 0) {
        // Mirrors the browser loop's own page-1 fallback: a discovery miss or
        // an empty selector match isn't necessarily a dead end, an LLM read
        // of the same static HTML often still finds the items.
        try {
          const cleaned = await cleanHtml(html, currentUrl, { mainContent: true });
          const markdown = await convertToMarkdown(cleaned.html);
          pageData = absolutizeLinkFields(await extractPageItems(currentUrl, markdown, goal, schema), schema, currentUrl);
        } catch (err) {
          log.info("Cheerio layer: LLM fallback failed, handing off to browser", { error: String(err) });
          return { allData, seenItemKeys, selectorPlan, pagesScraped, exhausted: false };
        }
        if (pageData.length === 0) {
          log.info("Cheerio layer: no items found on page 1 (selectors and LLM both empty), handing off to browser");
          return { allData, seenItemKeys, selectorPlan, pagesScraped, exhausted: false };
        }
        // LLM found items without a selector plan — fine for this one page,
        // but there's nothing to re-apply on page 2 via Cheerio. Hand
        // subsequent pagination to the browser rather than guess.
        mergeNew(pageData);
        pagesScraped++;
        return { allData, seenItemKeys, selectorPlan: null, pagesScraped, exhausted: false };
      }
    } else {
      pageData = selectorPlan ? extractWithSelectors(html, selectorPlan, currentUrl) : [];
      if (pageData.length === 0) {
        log.info("Cheerio layer: page returned 0 items, handing off to browser", { page: pagesScraped + 1 });
        return { allData, seenItemKeys, selectorPlan, pagesScraped, exhausted: false };
      }
    }

    mergeNew(pageData);
    pagesScraped++;

    const nextUrl = resolveNextUrlFromHtml(html, currentUrl, selectorPlan);
    if (!nextUrl || nextUrl === currentUrl) {
      log.info("Cheerio layer: pagination exhausted", { pagesScraped, totalItems: allData.length });
      return { allData, seenItemKeys, selectorPlan, pagesScraped, exhausted: true };
    }
    currentUrl = nextUrl;
  }

  // Hit maxPages while Cheerio was still finding real content — legitimately
  // done, not a failure the browser loop needs to redo.
  return { allData, seenItemKeys, selectorPlan, pagesScraped, exhausted: true };
}

/**
 * FAIL CLOSED: when the caller asked for a geography, the request MUST leave
 * through an APPROVED proxy (see getApprovedProxy) for that country (+ city). If it can't be built
 * (credentials missing) the job errors — it never degrades to a direct
 * connection or to a proxy-less region hint.
 */
export function requireGeoProxy(geo: CheerioGeo): ReturnType<typeof getApprovedProxy> {
  if (!geo.country) return undefined;
  const px = getApprovedProxy(geo.country, geo.city, { sticky: true }); // browser => sticky IP
  if (!px) {
    throw new Error(
      `options.country=${geo.country}${geo.city ? `/city=${geo.city}` : ""} requested but no approved proxy (Geonode) is configured ` +
      "(PROXY_URL/PROXY_USERNAME/PROXY_PASSWORD) — refusing to run without proxy",
    );
  }
  return px;
}

/**
 * Abrasio options for an explicit geography: `region` plus an explicit
 * country(+city) Geonode proxy (verified live: Abrasio cloud honors it).
 * Throws when the proxy can't be built (see requireGeoProxy).
 */
export function buildAbrasioGeoOptions(geo: CheerioGeo): { region?: string; proxy?: { server: string; username?: string; password?: string } } {
  if (!geo.country) return {};
  return { region: geo.country, proxy: requireGeoProxy(geo) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openBrowserPage(
  url: string, timeout: number, useAbrasio: boolean, geo: CheerioGeo = {},
): Promise<{ page: any; close: () => Promise<void>; reportBlocked: () => Promise<void> }> {
  if (useAbrasio) {
    // Hard-route domains (config.HARD_ROUTE_DOMAINS, e.g. Shopee) route to
    // Abrasio's home-server pool with a persistent logged-in session — same
    // rule doExtract() applies in orchestrator.ts, but dataset.ts has its own
    // browser-open path and never consulted hard-route.ts, so a marketplace
    // like Shopee always hit the normal fleet (no session) and came back
    // thin/blocked instead of using the logged-in home worker.
    const opts = { ...buildAbrasioGeoOptions(geo), hard: isHardRouteDomain(domainOf(url)) || undefined };
    const abrasio = await openAbrasioPersistentPage(url, timeout, opts);
    return { page: abrasio.page, close: abrasio.close, reportBlocked: abrasio.reportBlocked ?? (async () => {}) };
  }
  const country = geo.country ?? inferCountryFromUrl(url);
  const persistCtx = await getCtxForCountry(country);
  const proxyConfig = geo.country
    ? requireGeoProxy(geo) // fail closed: an explicit geography never runs without its proxy
    : playwrightProxyFor(country); // fail closed too (EgressPolicyError) — no swallowed errors
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
    reportBlocked: async () => {},
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
  const country = normalizeCountry(options.country);
  if (options.country && !country) log.warn("Ignoring invalid options.country", { country: options.country });
  // City only makes sense with a country (Geonode requires it) and a valid slug.
  const city = country ? normalizeCity(options.city) : undefined;
  if (options.city && !city) log.warn("Ignoring options.city (invalid slug or no country)", { city: options.city });
  const geo: CheerioGeo = { ...(country ? { country } : {}), ...(city ? { city } : {}) };

  requireGeoProxy(geo); // fail closed before any request leaves the machine
  log.info("Dataset extraction started", { url, goal, maxPages, country, city });

  // Layer 1: Cheerio + proxy, no browser at all. Same 3-tier ladder
  // orchestrator.ts already uses for /scrape, /extract, /crawl (Cheerio →
  // Patchright → Abrasio) — dataset.ts had only the last two, unconditionally
  // paying full browser overhead on every call. Skips the entire browser
  // phase below when it fully succeeds.
  const cheerioResult = await tryCheerioPath(url, goal, schema, maxPages, timeout, log, geo);
  if (cheerioResult.exhausted) {
    log.info("Dataset extraction completed via Cheerio only (no browser needed)", {
      url, pages: cheerioResult.pagesScraped, records: cheerioResult.allData.length,
      ms: Date.now() - start,
    });
    return {
      success: true,
      url,
      goal,
      total_records: cheerioResult.allData.length,
      pages_scraped: cheerioResult.pagesScraped,
      output_format: outputFormat,
      data: cheerioResult.allData,
      processing_time_ms: Date.now() - start,
    };
  }
  if (cheerioResult.pagesScraped > 0) {
    log.info("Cheerio layer found some data before hitting a wall, seeding the browser phase", {
      itemsSoFar: cheerioResult.allData.length,
    });
  }

  // Cheerio couldn't finish the job (blocked, no selector plan, or pagination
  // needs interactivity) — hand off to the browser ladder, seeded with
  // whatever Cheerio already collected so that work isn't thrown away.
  // pagesScraped intentionally restarts at 0: the browser loop below re-runs
  // its own complete, independently-tested discovery/extraction from page 1
  // rather than trying to resume mid-plan — seenItemKeys (seeded) makes any
  // overlap (e.g. re-visiting page 1) harmless, just slightly redundant, and
  // that redundancy is the safer trade against threading Cheerio's state into
  // browser-loop branches that assume they own page-1 discovery.
  const allData: Record<string, unknown>[] = [...cheerioResult.allData];
  const seenItemKeys = new Set<string>(cheerioResult.seenItemKeys);
  let pagesScraped = 0;
  let selectorPlan: SelectorPlan | null = null;
  let consecutiveSelectorFailures = 0;

  // Browser setup: Abrasio stealth engine (if configured) → Patchright otherwise.
  // Both return a Playwright-compatible page kept open across the full pagination loop.
  // Hard-route domains need Abrasio (the home-server pool holds the logged-in
  // session) — same short-circuit orchestrator.doExtract() applies; skips
  // straight past Patchright instead of burning a full attempt on a fleet
  // that has no session for this site.
  // hardRoute only matters when Abrasio is actually configured — a deploy
  // without Abrasio still falls through to Patchright instead of failing
  // outright (mirrors orchestrator.ts's `opts.forceAbrasio && isAbrasioAvailable()`).
  const hardRoute = isHardRouteDomain(domainOf(url));
  let usingAbrasio = isAbrasioAvailable();
  log.info(usingAbrasio ? "Dataset using Abrasio stealth browser" : "Dataset using Patchright browser", { hardRoute });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;
  let closeBrowser: () => Promise<void>;
  let reportBlocked: () => Promise<void> = async () => {};
  ({ page, close: closeBrowser, reportBlocked } = await openBrowserPage(url, timeout, usingAbrasio, geo));

  // Settles the page after a goto: waits for network idle, then — Abrasio
  // only — checks for a captcha/challenge wall and waits for Abrasio's
  // solving extensions to clear it before returning. Patchright has no
  // solver, so waiting there would just burn time with no chance of
  // resolving; only worth it once Abrasio is actually in the driver's seat.
  //
  // Added 2026-08-19 after a real production failure: a ligapokemon.com.br
  // dataset job discovered a plausible selector ("div.card-item") but
  // extracted 0 items from it, on a page that was almost certainly still
  // showing Cloudflare Turnstile's "Verificação bem-sucedida. Esperando a
  // resposta de..." hold state when we captured the HTML — the widget had
  // passed but the real listing hadn't rendered yet. `isCaptchaPage`/
  // `waitForCaptchaResolution` already existed in abrasio-engine.ts for the
  // single-shot `/scrape`,`/extract`,`/crawl` path (fetchWithInstance) but
  // were never wired into `openAbrasioPersistentPage`, which dataset.ts (and
  // instagram.ts/x.ts) use — this was the actual gap, not the selector or
  // the scroll logic, both already fixed today.
  const settleAfterGoto = async (): Promise<void> => {
    await page.waitForTimeout(1500);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8_000 });
    } catch {
      // Pages with background polling/websockets never go idle — proceed anyway.
    }
    if (usingAbrasio && (await isCaptchaPage(page).catch(() => false))) {
      let resolved = true;
      await waitForCaptchaResolution(page, url).catch((err: unknown) => {
        resolved = false;
        log.warn("Captcha did not resolve within budget, proceeding with whatever loaded", {
          url, error: String(err),
        });
      });
      // waitForCaptchaResolution only waits for "domcontentloaded" once the
      // challenge widget itself is gone — that fires as soon as the (still
      // mostly empty) DOM shell is parsed, not once the real listing has
      // actually loaded. Confirmed 2026-08-20, three local runs against the
      // same ligapokemon.com.br listing: captcha resolved cleanly (no
      // warning logged), yet selector discovery still found 0 items — the
      // card grid is populated by a follow-up XHR that fires AFTER the
      // widget clears, and we were reading the DOM before it landed. One
      // more networkidle wait here, only on the success path, closes that
      // gap without adding cost to the (more common) no-captcha case.
      if (resolved) {
        try {
          await page.waitForLoadState("networkidle", { timeout: 10_000 });
        } catch {
          // Pages with background polling/websockets never go idle — proceed anyway.
        }
      }
    }
  };

  // A goto() that THROWS (DNS failure, TLS error, or a network-level error
  // like net::ERR_HTTP2_PROTOCOL_ERROR — confirmed live 2026-09-22 against
  // in.gov.br, whose HTTP/2 stack Chromium's stricter implementation
  // sometimes rejects outright) is a different failure mode from a goto that
  // SUCCEEDS but returns thin/blocked content — the escalation logic below
  // already handles the latter, but until now nothing caught the former, so
  // it crashed the whole job uncaught before either engine got a real look.
  // Treated the same way here: log it, don't let it propagate, and let the
  // thin/blocked check below (page.content() on a failed navigation is "",
  // which isThinOrBlocked() correctly treats as thin) decide whether to
  // escalate to the other engine.
  const safeGoto = async (): Promise<void> => {
    try {
      await page.goto(url, { waitUntil: "load", timeout });
      await settleAfterGoto();
    } catch (err) {
      log.warn("Navigation failed (network/protocol error), treating as thin/blocked for escalation purposes", {
        url, usingAbrasio, error: String(err),
      });
    }
  };

  try {
    log.info("Navigating to initial URL", { url });
    await safeGoto();

    // If the engine we picked came back thin/blocked (captcha wall, anti-bot
    // interstitial, empty shell, or a navigation that failed outright), retry
    // once with the OTHER engine — mirrors the escalation orchestrator.ts
    // does for /scrape, /crawl and /extract, adapted for a long-lived page
    // instead of a single fetch. Bidirectional: Patchright→Abrasio was the
    // only direction this handled until today.
    if (!usingAbrasio && isAbrasioAvailable() && isThinOrBlocked(await page.content().catch(() => ""))) {
      log.warn("Patchright returned thin/blocked content (or failed to navigate) on initial load, escalating to Abrasio", { url });
      await closeBrowser().catch(() => {});
      usingAbrasio = true;
      ({ page, close: closeBrowser, reportBlocked } = await openBrowserPage(url, timeout, true, geo));
      await safeGoto();
    } else if (usingAbrasio && !hardRoute && isThinOrBlocked(await page.content().catch(() => ""))) {
      // Skipped for hard-route domains: Patchright's fleet has no logged-in
      // session for these sites either, so falling back to it would just
      // burn another attempt on a wall it can't get past — same reasoning
      // orchestrator.ts's forceAbrasio path uses.
      //
      // Confirmed 2026-08-20 on a real production job: dataset.ts always
      // starts with Abrasio whenever it's configured (isAbrasioAvailable()
      // — true in production, unconditionally), with no fallback if THAT
      // specific run comes back blocked. Abrasio is normally the stronger
      // stealth layer, but "stronger" isn't "never blocked" — its egress IP
      // can get flagged same as any other, and when it does, the job
      // returned 0 items even though /api/extract succeeded on the exact
      // same URL in the same window via Patchright's Geonode-proxied path.
      // There was a fallback FROM Patchright TO Abrasio; there was never
      // one the other way. Try the proven-working alternative instead of
      // accepting defeat.
      log.warn("Abrasio returned thin/blocked content (egress IP likely flagged), falling back to Patchright", { url });
      await reportBlocked(); // static ISP proxy => cooldown; the next attempt goes to Geonode
      await closeBrowser().catch(() => {});
      reportBlocked = async () => {};
      usingAbrasio = false;
      ({ page, close: closeBrowser } = await openBrowserPage(url, timeout, false, geo));
      await safeGoto();
    }

    if (isThinOrBlocked(await page.content().catch(() => ""))) {
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
      // .catch(() => "") for the same reason as the thin/blocked checks
      // above: if navigation never actually succeeded on either engine,
      // page.content() can throw instead of just returning an empty shell —
      // treat that the same as "0 items on this page" rather than crashing
      // the whole job.
      const html = await page.content().catch(() => "");
      const currentUrl = page.url();

      let pageData: Record<string, unknown>[] = [];
      let extractionFailed = false;

      if (pagesScraped === 0) {
        // Page 1: discover selectors via LLM, then extract with Cheerio
        log.info("Discovering selectors from page 1", { url: currentUrl });
        ({ plan: selectorPlan, items: pageData } = await discoverValidatedPlan(currentUrl, html, goal, schema, log));
        if (selectorPlan) {
          log.info("Selector plan discovered", {
            container: selectorPlan.item_container,
            fields: Object.keys(selectorPlan.fields),
            paginationNext: selectorPlan.pagination_next,
          });
        }
        // A valid plan but 0 items usually means the list had not hydrated yet when we read the
        // HTML (slow proxy, SPA redirect). Wait for the container, re-read and re-extract once
        // before giving up on the plan and falling back to LLM/scroll.
        if (pageData.length === 0 && selectorPlan?.item_container) {
          const appeared = await page.waitForSelector(selectorPlan.item_container, { timeout: 15_000 }).then(() => true, () => false);
          if (appeared) {
            const fresh = await page.content().catch(() => "");
            pageData = extractWithSelectors(fresh, selectorPlan, page.url());
            log.info("Item container appeared after waiting, re-extracted", { items: pageData.length });
          }
        }
        // If discovery failed or selectors returned nothing, fall back to LLM.
        // Keep selectorPlan alive so pages 2+ can still try Cheerio — the plan
        // may be valid but page 1 rendered differently (lazy load, JS delay, etc.).
        // consecutiveSelectorFailures will abandon it if it keeps failing.
        if (pageData.length === 0) {
          log.info("Selector extraction empty on page 1, falling back to LLM (keeping plan for page 2+)");
          try {
            const cleaned = await cleanHtml(html, currentUrl, { mainContent: true });
            // const markdown = await convertToMarkdown(cleaned.html);
            pageData = absolutizeLinkFields(await extractPageItems(currentUrl, cleaned.html, goal, schema), schema, currentUrl);
          } catch (err) {
            extractionFailed = true;
            log.warn("LLM extraction also failed on page 1", { error: String(err) });
          }
        }
      } else if (selectorPlan) {
        // Pages 2+: fast path — Cheerio only
        pageData = extractWithSelectors(html, selectorPlan, currentUrl);
        if (pageData.length === 0) {
          consecutiveSelectorFailures++;
          if (consecutiveSelectorFailures >= 2) {
            log.warn("Selector plan abandoned after consecutive failures", { page: pagesScraped + 1 });
            selectorPlan = null;
          }
          // Fall back to LLM for this page
          log.info("Cheerio returned 0 items, falling back to LLM for this page", { page: pagesScraped + 1 });
          try {
            const cleaned = await cleanHtml(html, currentUrl, { mainContent: true });
            const markdown = await convertToMarkdown(cleaned.html);
            pageData = absolutizeLinkFields(await extractPageItems(currentUrl, markdown, goal, schema), schema, currentUrl);
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
          const cleaned = await cleanHtml(html, currentUrl, { mainContent: true });
          const markdown = await convertToMarkdown(cleaned.html);
          pageData = absolutizeLinkFields(await extractPageItems(currentUrl, markdown, goal, schema), schema, currentUrl);
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
      const wasFirstPage = pagesScraped === 0;
      pagesScraped++;

      // Scroll-and-collect fallback: sites like listing/marketplace pages often
      // append — or, as confirmed on a real 118-item ligapokemon.com.br
      // listing, VIRTUALIZE (swap, not append) — more items on scroll with no
      // "next" element to find in the first place. Extraction happens after
      // every scroll step inside scrollAndCollect (not once at the end — a
      // virtualized list never has more than one window's worth in the DOM at
      // a time, so a single final snapshot would miss everything outside the
      // last window). Budget is tied to the job's own declared timeout
      // (bounded 30s–120s). Counts as ONE page toward `maxPages` regardless of
      // how many scroll ticks it took. Returns whether it found anything new.
      const tryScrollFallback = async (): Promise<boolean> => {
        if (!selectorPlan) return false;
        const scrollBudgetMs = Math.max(30_000, Math.min(120_000, timeout));
        const scrolledNew = await scrollAndCollect(
          page, selectorPlan, log, scrollBudgetMs, allData, seenItemKeys,
        );
        if (scrolledNew > 0) {
          log.info("Infinite-scroll collection complete", { newItems: scrolledNew, totalItems: allData.length });
          return true;
        }
        return false;
      };

      // Stop when extraction succeeded but genuinely found nothing NEW — either
      // the page has no items at all, or (pages after the first only) it had
      // items but every one was already seen. The second case matters because a
      // "next" click can succeed without error yet land somewhere that isn't
      // real pagination (a mis-detected control, a no-op), silently re-showing
      // the same page; without this check the loop would keep clicking the same
      // dead end up to `maxPages` instead of ever trying scroll. Try scroll
      // before giving up either way — a genuinely stuck click and a page that's
      // just slow to reveal a "next" control look identical from here.
      if (!extractionFailed && (pageData.length === 0 || (!wasFirstPage && newItems.length === 0))) {
        if (await tryScrollFallback()) break;
        log.info("No new items on page and scroll produced nothing either, pagination complete", { page: pagesScraped });
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
        // No clickable next-page control anywhere on the page.
        if (await tryScrollFallback()) break;
        log.info("No next page button found and scroll produced no new items, pagination complete", { page: pagesScraped });
        break;
      }

      log.info("Clicking next page", { via: matchedVia, page: pagesScraped + 1 });
      try {
        await nextEl.click();
      } catch {
        // Element may have been detached, or matched something that was never
        // a real "next" control at all (e.g. a scroll-triggered lazy-load
        // sentinel picked up by a loose static selector like
        // "[class*='load-more']" — confirmed on ligapokemon.com.br: it matched
        // an element that wasn't clickable, and the code used to just stop
        // here, never trying scroll at all even though the LLM-discovered
        // plan had already said pagination_next was null). A failed click is
        // exactly the situation the scroll fallback exists for — try it
        // before giving up.
        log.info("Next element click failed, trying scroll fallback before stopping", { via: matchedVia });
        if (await tryScrollFallback()) break;
        log.info("Scroll fallback also produced nothing new, stopping pagination", { via: matchedVia });
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
