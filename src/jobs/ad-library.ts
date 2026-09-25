import { Job } from "bullmq";
import { isAbrasioAvailable, openAbrasioPersistentPage, isCaptchaPage, waitForCaptchaResolution } from "../engine/abrasio-engine.js";
import { getCtxForCountry } from "../engine/playwright-engine.js";
import { childLogger } from "../utils/logger.js";

/**
 * Meta Ad Library ("biblioteca de anúncios") — public, no login.
 *
 * Why a dedicated job (and not `dataset`): the result cards have no per-ad
 * <a href>, so a generic selector-based extractor returns the search URL itself.
 * The ads live in JSON: the initial document embeds a Relay payload in
 * `<script type="application/json" data-sjs>` and every scroll page comes back as a
 * `POST /api/graphql/` response. Both carry
 * `search_results_connection.edges[].node.collated_results[]`, one object per ad.
 *
 * Official alternative: Meta's Ad Library API (`ads_archive`) needs an access token and
 * identity verification of the account, and — per 2026 research (not tested by us with a
 * token) — it only covers political/social-issue ads outside the EU/UK, so it does NOT
 * cover commercial ads in Brazil. This browser-based job is therefore the only viable
 * route for commercial BR ads.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AdLibraryJobData {
  query: string;
  country?: string;                 // ISO 3166 alpha-2, default "BR"
  active_status?: "active" | "all"; // default "all"
  max_ads?: number;                 // default 50, cap 200
  timeout?: number;                 // seconds, default 90
}

export interface AdLibraryAd {
  ad_archive_id: string;
  ad_library_url: string;
  page_id: string | null;
  page_name: string | null;
  page_url: string | null;
  body_text: string | null;
  is_active: boolean | null;
  start_date: string | null;        // ISO 8601 (from epoch seconds)
  end_date: string | null;
  publisher_platforms: string[];    // e.g. ["FACEBOOK","INSTAGRAM"]
  display_format: string | null;    // e.g. "VIDEO", "IMAGE", "DPA"
  title: string | null;
  link_url: string | null;
  cta_text: string | null;
  page_categories: string[];
  collation_count: number | null;   // how many near-duplicate ads Meta grouped under this one
}

export interface AdLibraryData {
  query: string;
  country: string;
  active_status: string;
  source_url: string;
  ads: AdLibraryAd[];
  total_found: number | null;       // "~1.100 resultados" (search_results_connection.count)
  truncated: boolean;
  skipped_malformed: number;
  warnings: string[];
}

export interface AdLibraryJobResult {
  success: boolean;
  resource: "ad_library";
  data?: AdLibraryData;
  blocked?: boolean;
  structure_changed?: boolean;
  message?: string;
  diagnostics?: Record<string, unknown>;
  processing_time_ms: number;
}

export interface ParsedAdPayload {
  ads: AdLibraryAd[];
  total_found: number | null;
  has_next_page: boolean | null;
  skipped_malformed: number;
  /** true when a `search_results_connection` (even an empty one) was seen — i.e. the structure is recognized. */
  connection_seen: boolean;
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

export const AD_LIBRARY_MAX_ADS_CAP = 200;
export const AD_LIBRARY_DEFAULT_MAX_ADS = 50;

export function buildAdLibraryUrl(query: string, country = "BR", activeStatus: "active" | "all" = "all"): string {
  const params = new URLSearchParams({
    active_status: activeStatus,
    ad_type: "all",
    country: country.toUpperCase(),
    q: query,
    search_type: "keyword_unordered",
    media_type: "all",
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

export function adLibraryAdUrl(adArchiveId: string): string {
  return `https://www.facebook.com/ads/library/?id=${adArchiveId}`;
}

// Used by the Python API layer (routes/ai.py) — same shape as computeInstagramCredits. PROVISIONAL.
export function computeAdLibraryCredits(maxAds: number): number {
  return Math.max(1, Math.ceil(maxAds / 10));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function str(v: unknown): string | null {
  // whitespace-only strings (e.g. " " card bodies on dynamic product ads) count as absent
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function epochToIso(v: unknown): string | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Normalizes one raw `collated_results[]` item. Returns null if it isn't a usable ad. */
export function normalizeAd(raw: Any): AdLibraryAd | null {
  if (!raw || typeof raw !== "object") return null;
  const idRaw = raw.ad_archive_id;
  const id = typeof idRaw === "number" ? String(idRaw) : idRaw;
  if (typeof id !== "string" || !/^\d{5,25}$/.test(id)) return null;

  const snap = raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : {};
  const pageId = str(raw.page_id) ?? str(snap.page_id);
  const body =
    str(snap.body?.text) ??
    (Array.isArray(snap.cards) ? str(snap.cards.find((c: Any) => str(c?.body))?.body) : null);

  return {
    ad_archive_id: id,
    ad_library_url: adLibraryAdUrl(id),
    page_id: pageId,
    page_name: str(raw.page_name) ?? str(snap.page_name),
    page_url: pageId && /^\d+$/.test(pageId) ? `https://www.facebook.com/${pageId}/` : null,
    body_text: body,
    is_active: typeof raw.is_active === "boolean" ? raw.is_active : null,
    start_date: epochToIso(raw.start_date),
    end_date: epochToIso(raw.end_date),
    publisher_platforms: strArray(raw.publisher_platform),
    display_format: str(snap.display_format),
    title: str(snap.title),
    link_url: str(snap.link_url),
    cta_text: str(snap.cta_text),
    page_categories: strArray(snap.page_categories),
    collation_count: typeof raw.collation_count === "number" ? raw.collation_count : null,
  };
}

/**
 * Walks an already-parsed JSON tree collecting ads. Tolerant of any missing key; never throws.
 * Ads are recognized structurally (object with `ad_archive_id`), not by a fixed path, so a
 * wrapper change (`require[...]`, `__bbox`, `ad_library_main`) doesn't break it.
 */
export function collectAdsFromJson(root: unknown, acc: ParsedAdPayload): void {
  const walk = (node: Any, depth: number): void => {
    if (depth > 40 || node === null || typeof node !== "object") return;
    if (!Array.isArray(node)) {
      const conn = node.search_results_connection;
      if (conn && typeof conn === "object") {
        acc.connection_seen = true;
        if (typeof conn.count === "number" && conn.count >= 0) acc.total_found = conn.count;
        if (typeof conn.page_info?.has_next_page === "boolean") acc.has_next_page = conn.page_info.has_next_page;
      }
      if ("ad_archive_id" in node) {
        try {
          const ad = normalizeAd(node);
          if (ad) acc.ads.push(ad);
          else acc.skipped_malformed++;
        } catch {
          acc.skipped_malformed++;
        }
        return; // don't descend into an ad (snapshot has no nested ads)
      }
    }
    const children: unknown[] = Array.isArray(node) ? node : Object.values(node);
    for (const c of children) walk(c, depth + 1);
  };
  try {
    walk(root, 0);
  } catch {
    /* defensive: a pathological tree must not fail the job */
  }
}

function newAcc(): ParsedAdPayload {
  return { ads: [], total_found: null, has_next_page: null, skipped_malformed: 0, connection_seen: false };
}

/** Parses a `/api/graphql/` response body (plain JSON, possibly `for (;;);`-prefixed or NDJSON). */
export function parseAdLibraryGraphql(text: string): ParsedAdPayload {
  const acc = newAcc();
  if (typeof text !== "string" || text.length === 0) return acc;
  const cleaned = text.replace(/^\s*for\s*\(;;\);\s*/, "");
  try {
    collectAdsFromJson(JSON.parse(cleaned), acc);
    return acc;
  } catch {
    /* maybe NDJSON / multiple documents: try line by line */
  }
  for (const line of cleaned.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    try {
      collectAdsFromJson(JSON.parse(t), acc);
    } catch {
      /* skip malformed line */
    }
  }
  return acc;
}

/**
 * Parses the initial document: only `<script type="application/json">` blocks that mention
 * `ad_archive_id` are JSON.parse'd (no regex over the whole HTML for values).
 */
export function parseAdLibraryHtml(html: string): ParsedAdPayload {
  const acc = newAcc();
  if (typeof html !== "string" || html.length === 0) return acc;
  const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1];
    if (!body.includes("ad_archive_id") && !body.includes("search_results_connection")) continue;
    try {
      collectAdsFromJson(JSON.parse(body), acc);
    } catch {
      /* malformed block: skip */
    }
  }
  return acc;
}

/** Merges parsed payloads into a dedup map (first occurrence wins, keeps document order). */
export function mergeParsed(target: Map<string, AdLibraryAd>, parsed: ParsedAdPayload): number {
  let added = 0;
  for (const ad of parsed.ads) {
    if (!target.has(ad.ad_archive_id)) {
      target.set(ad.ad_archive_id, ad);
      added++;
    }
  }
  return added;
}

/** Detects login / checkpoint / block / captcha pages from url + visible text. */
export function detectAdLibraryBlock(url: string, title: string, text: string): string | null {
  const u = url.toLowerCase();
  if (u.includes("/login") || u.includes("/checkpoint") || u.includes("/recover")) return "login_or_checkpoint_redirect";
  const hay = `${title}\n${text.slice(0, 4000)}`.toLowerCase();
  const markers = [
    "you must log in", "log in to continue", "faça login para continuar", "você precisa entrar",
    "temporarily blocked", "temporariamente bloqueado", "you're temporarily blocked",
    "we suspect automated", "security check", "verificação de segurança",
    "this content isn't available", "este conteúdo não está disponível",
  ];
  const hit = markers.find((k) => hay.includes(k));
  return hit ? `block_marker:${hit}` : null;
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_S = 90;
const SCROLL_WAIT_MS = 2_500;
const MAX_STALLED_ROUNDS = 3;

export async function processAdLibraryJob(job: Job<AdLibraryJobData>): Promise<AdLibraryJobResult> {
  const log = childLogger({ jobId: job.id, queue: "ad-library" });
  const start = Date.now();
  const query = String(job.data.query ?? "").trim();
  const country = String(job.data.country ?? "BR").toUpperCase();
  const activeStatus = job.data.active_status === "active" ? "active" : "all";
  const maxAds = Math.min(Math.max(1, Math.floor(job.data.max_ads ?? AD_LIBRARY_DEFAULT_MAX_ADS)), AD_LIBRARY_MAX_ADS_CAP);
  const timeoutMs = Math.max(10, job.data.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
  const fail = (message: string, extra: Partial<AdLibraryJobResult> = {}): AdLibraryJobResult => ({
    success: false, resource: "ad_library", message, processing_time_ms: Date.now() - start, ...extra,
  });

  if (!query) return fail("query is required");
  if (!/^[A-Z]{2}$/.test(country)) return fail("country must be an ISO 3166 alpha-2 code");

  const targetUrl = buildAdLibraryUrl(query, country, activeStatus);
  log.info("Ad Library job started", { query: query.slice(0, 60), country, activeStatus, maxAds });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;
  let closeBrowser: () => Promise<void>;
  const usingAbrasio = isAbrasioAvailable();
  if (usingAbrasio) {
    // region is forwarded so the SDK picks locale/timezone for the requested country
    // (facebook.com's TLD says nothing about it). The URL's country= drives the results.
    const abrasio = await openAbrasioPersistentPage(targetUrl, timeoutMs, { region: country });
    page = abrasio.page;
    closeBrowser = abrasio.close;
  } else {
    const persistCtx = await getCtxForCountry(country);
    page = await persistCtx.newPage();
    closeBrowser = async () => { await page.close().catch(() => {}); };
  }

  const deadline = start + timeoutMs;
  const ads = new Map<string, AdLibraryAd>();
  const state = { total: null as number | null, hasNext: null as boolean | null, skipped: 0, connectionSeen: false, gqlResponses: 0 };
  const absorb = (p: ParsedAdPayload): number => {
    if (p.total_found !== null && state.total === null) state.total = p.total_found;
    if (p.has_next_page !== null) state.hasNext = p.has_next_page;
    state.skipped += p.skipped_malformed;
    state.connectionSeen ||= p.connection_seen;
    return mergeParsed(ads, p);
  };

  try {
    // Passive listener (no route interception), attached before navigation.
    page.on("response", async (response: Any) => {
      try {
        if (!String(response.url()).includes("/api/graphql")) return;
        const text: string = await response.text();
        if (!text.includes("ad_archive_id") && !text.includes("search_results_connection")) return;
        state.gqlResponses++;
        absorb(parseAdLibraryGraphql(text));
      } catch { /* ignore */ }
    });

    await job.updateProgress({ phase: "navigating", pct: 15 });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 60_000) });
    try { await page.waitForLoadState("load", { timeout: 8_000 }); } catch { /* proceed */ }
    if (usingAbrasio && (await isCaptchaPage(page).catch(() => false))) {
      await waitForCaptchaResolution(page, targetUrl).catch((err: unknown) => {
        log.warn("Captcha did not resolve within budget", { error: String(err) });
      });
    }
    await page.waitForTimeout(3_000);

    const initialHtml: string = await page.content();
    absorb(parseAdLibraryHtml(initialHtml));

    const finalUrl: string = page.url();
    const title: string = await page.title().catch(() => "");
    const visible: string = await page.evaluate("document.body ? document.body.innerText : \"\"").catch(() => "");
    log.info("Ad Library loaded", { finalUrl, initialAds: ads.size, total: state.total });

    if (ads.size === 0) {
      const blockReason = detectAdLibraryBlock(finalUrl, title, visible);
      const diagnostics = { final_url: finalUrl, title: title.slice(0, 120), html_bytes: initialHtml.length, text_sample: visible.slice(0, 200), connection_seen: state.connectionSeen, block_reason: blockReason };
      if (blockReason) return fail("Meta Ad Library blocked the request (login/captcha/checkpoint).", { blocked: true, diagnostics });
      if (state.connectionSeen && state.total === 0) {
        return {
          success: true, resource: "ad_library", processing_time_ms: Date.now() - start,
          data: { query, country, active_status: activeStatus, source_url: targetUrl, ads: [], total_found: 0, truncated: false, skipped_malformed: state.skipped, warnings: ["No ads found for this query."] },
        };
      }
      // Give scrolling one chance before declaring the structure changed (lazy first page).
    }

    // Scroll until max_ads, exhaustion (has_next_page=false), stall, or deadline.
    await job.updateProgress({ phase: "scrolling", pct: 40 });
    let stalled = 0;
    while (ads.size < maxAds && Date.now() < deadline - SCROLL_WAIT_MS && stalled < MAX_STALLED_ROUNDS) {
      if (state.hasNext === false && ads.size > 0) break;
      const before = ads.size;
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)").catch(() => {});
      await page.waitForTimeout(SCROLL_WAIT_MS);
      stalled = ads.size > before ? 0 : stalled + 1;
    }

    await job.updateProgress({ phase: "parsing", pct: 85 });

    if (ads.size === 0) {
      return fail(
        "No ads could be extracted: the page structure may have changed, or the request was served a degraded page.",
        { structure_changed: true, diagnostics: { final_url: page.url(), title: title.slice(0, 120), text_sample: visible.slice(0, 200), connection_seen: state.connectionSeen, graphql_responses_with_ads: state.gqlResponses } },
      );
    }

    const all = [...ads.values()];
    const truncated = all.length > maxAds || (all.length === maxAds && state.hasNext !== false);
    const warnings: string[] = [];
    if (state.skipped > 0) warnings.push(`${state.skipped} malformed ad item(s) skipped.`);
    if (all.length < maxAds && state.hasNext !== false) warnings.push("Stopped before reaching max_ads (timeout or no further pages loaded).");

    log.info("Ad Library job completed", { ads: Math.min(all.length, maxAds), total: state.total, ms: Date.now() - start });
    return {
      success: true, resource: "ad_library", processing_time_ms: Date.now() - start,
      data: {
        query, country, active_status: activeStatus, source_url: targetUrl,
        ads: all.slice(0, maxAds), total_found: state.total, truncated,
        skipped_malformed: state.skipped, warnings,
      },
    };
  } finally {
    await closeBrowser();
  }
}
