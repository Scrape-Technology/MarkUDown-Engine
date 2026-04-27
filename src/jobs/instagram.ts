import { Job } from "bullmq";
import { isAbrasioAvailable, openAbrasioPersistentPage } from "../engine/abrasio-engine.js";
import { getCtxForCountry } from "../engine/playwright-engine.js";
import { inferCountryFromUrl } from "../utils/proxy-region.js";
import { childLogger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InstagramJobData {
  resource: "profile" | "post" | "hashtag" | "search";
  target: string;
  limit?: number;
  session_cookie?: string;
}

export interface InstagramJobResult {
  success: boolean;
  resource: string;
  data?: unknown;
  blocked?: boolean;
  session_required?: boolean;
  session_invalid?: boolean;
  rate_limited?: boolean;
  not_found?: boolean;
  message?: string;
  processing_time_ms: number;
}

interface ParsedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

export function parseCookieString(cookieStr: string, domain: string): ParsedCookie[] {
  return cookieStr
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes("="))
    .map((pair) => {
      const eqIdx = pair.indexOf("=");
      return {
        name: pair.slice(0, eqIdx).trim(),
        value: pair.slice(eqIdx + 1).trim(),
        domain,
        path: "/",
        secure: true,   // required for Playwright to send cookies over HTTPS
        sameSite: "Lax" as const,
      };
    });
}

export function isInstagramLoginRedirect(url: string): boolean {
  return url.includes("/accounts/login") || url.includes("/challenge/");
}

export function buildInstagramUrl(resource: string, target: string): string {
  switch (resource) {
    case "profile":
      return `https://www.instagram.com/${target}/`;
    case "hashtag": {
      // Strip leading # if the caller included it (e.g. "#ferrari" → "ferrari")
      const tag = target.replace(/^#+/, "");
      return `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
    }
    case "search":
      return `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(target)}`;
    case "post":
    default:
      return target.startsWith("http") ? target : `https://www.instagram.com/p/${target}/`;
  }
}

// Used by the Python API layer (routes/ai.py) to validate credits before dispatch.
export function computeInstagramCredits(resource: string, limit: number): number {
  if (resource === "profile" || resource === "post") return 1;
  return Math.max(1, Math.ceil(limit / 10));
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 5_000;

export async function processInstagramJob(
  job: Job<InstagramJobData>
): Promise<InstagramJobResult> {
  const log = childLogger({ jobId: job.id, queue: "instagram" });
  const start = Date.now();
  const { resource, target, limit = 20, session_cookie } = job.data;

  log.info("Instagram job started", { resource, target: target.slice(0, 80) });

  const targetUrl = buildInstagramUrl(resource, target);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;
  let closeBrowser: () => Promise<void>;

  if (isAbrasioAvailable()) {
    log.info("Instagram using Abrasio stealth browser");
    const abrasio = await openAbrasioPersistentPage(targetUrl, TIMEOUT_MS);
    page = abrasio.page;
    closeBrowser = abrasio.close;
  } else {
    log.info("Instagram using Patchright browser");
    const country = inferCountryFromUrl(targetUrl);
    const persistCtx = await getCtxForCountry(country);
    // Use persistCtx.newPage() — reuses the persistent browser profile (history, fingerprint,
    // localStorage) so Instagram doesn't flag the session as a fresh bot context.
    page = await persistCtx.newPage();
    closeBrowser = async () => {
      await page.close().catch(() => {});
    };
  }

  try {
    const apiPayloads: unknown[] = [];

    // Listen to responses passively — no route interception, no re-fetch.
    // page.route()+fetch() sends a second request which Instagram flags as bot behaviour.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (page as any).on("response", async (response: any) => {
      try {
        const url: string = response.url();
        const isApi = url.includes("instagram.com/api/v1/") || url.includes("instagram.com/api/graphql");
        if (!isApi) return;
        const ct: string = response.headers()["content-type"] ?? "";
        if (!ct.includes("application/json")) return;
        const body = await response.json().catch(() => null);
        if (body) apiPayloads.push(body);
      } catch { /* ignore */ }
    });

    if (session_cookie) {
      const cookies = parseCookieString(session_cookie, ".instagram.com");
      await (page as any).context().addCookies(cookies); // eslint-disable-line @typescript-eslint/no-explicit-any
      log.info("Session cookie injected");
    }

    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) {
        log.info("Retrying after rate limit delay", { attempt });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }

      await job.updateProgress({ phase: "navigating", pct: 20 });
      await (page as any).goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }); // eslint-disable-line @typescript-eslint/no-explicit-any
      await page.waitForLoadState();
      
      const currentUrl: string = (page as any).url(); // eslint-disable-line @typescript-eslint/no-explicit-any
      log.info("Navigated", { url: currentUrl });

      if (isInstagramLoginRedirect(currentUrl)) {
        if (session_cookie) {
          return {
            success: false,
            resource,
            blocked: true,
            session_invalid: true,
            message: "Instagram rejected the session cookie. Provide a valid sessionid.",
            processing_time_ms: Date.now() - start,
          };
        }
        return {
          success: false,
          resource,
          blocked: true,
          session_required: true,
          message: "Instagram requires authentication for this content. Provide session_cookie.",
          processing_time_ms: Date.now() - start,
        };
      }

      await job.updateProgress({ phase: "extracting", pct: 60 });
      await (page as any).waitForTimeout(2000); // eslint-disable-line @typescript-eslint/no-explicit-any

      const html: string = await (page as any).content(); // eslint-disable-line @typescript-eslint/no-explicit-any

      if (html.includes('"login_required"') || html.includes("Please wait a few minutes")) {
        if (attempt < 2) {
          log.warn("Rate limited by Instagram, will retry", { attempt });
          continue;
        }
        return {
          success: false,
          resource,
          rate_limited: true,
          message: "Instagram rate limited this request. Try again later.",
          processing_time_ms: Date.now() - start,
        };
      }

      if (html.includes('"not_found"') || html.includes("Sorry, this page")) {
        return {
          success: false,
          resource,
          not_found: true,
          message: "Resource not found: private, deleted, or does not exist.",
          processing_time_ms: Date.now() - start,
        };
      }

      if (html.includes("Your Request Couldn") || html.includes("request couldn") || html.includes("couldn't be processed")) {
        if (attempt < 2) {
          log.warn("Instagram blocked request, will retry", { attempt });
          continue;
        }
        return {
          success: false,
          resource,
          blocked: true,
          message: "Instagram blocked this request. The session may be flagged or the IP is rate-limited.",
          processing_time_ms: Date.now() - start,
        };
      }

      await job.updateProgress({ phase: "parsing", pct: 80 });

      const data = await extractInstagramData(page, resource, target, limit, apiPayloads, log, html);

      await job.updateProgress({ phase: "done", pct: 100 });
      log.info("Instagram job completed", { resource, ms: Date.now() - start });

      return {
        success: true,
        resource,
        data,
        processing_time_ms: Date.now() - start,
      };
    }
  } finally {
    await closeBrowser();
  }

  return {
    success: false,
    resource,
    rate_limited: true,
    message: "Instagram rate limited this request after 2 retries.",
    processing_time_ms: Date.now() - start,
  };
}

// ─── Extraction ──────────────────────────────────────────────────────────────

async function extractInstagramData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  resource: string,
  target: string,
  limit: number,
  apiPayloads: unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any,
  html: string
): Promise<unknown> {
  switch (resource) {
    case "profile":
      return extractProfile(target, apiPayloads, log, html);
    case "post":
      return extractPost(target, apiPayloads, html);
    case "hashtag":
      return extractHashtag(page, target, limit, apiPayloads, log);
    case "search":
      return extractSearch(page, target, limit, apiPayloads, log);
    default:
      return null;
  }
}

async function extractProfile(username: string, apiPayloads: unknown[], log: ReturnType<typeof import("../utils/logger.js").childLogger>, html: string): Promise<unknown> {
  // 1. Try intercepted API/GraphQL payloads
  for (const apiPayload of apiPayloads) {
    if (!apiPayload || typeof apiPayload !== "object") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = apiPayload as any;
    const raw =
      p?.data?.xdt_api__v1__users__web_profile_info__connection?.data?.user ??
      p?.data?.user?.result ??
      p?.data?.user ??
      p?.graphql?.user ??
      p?.user;
    if (!raw?.username) continue;
    const u = raw.legacy ?? raw;
    return buildProfileObject(u, raw, username);
  }

  // 2. Parse HTML in Node.js — no page.evaluate, no browser JS execution
  const user = parseUserFromHtml(html, username);

  // 3. Open Graph meta tags — server-rendered, always present, no JS needed
  const og = parseProfileFromOpenGraph(html);

  if (user) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = (user as any).legacy ?? user;
    const built = buildProfileObject(u, user, username) as Record<string, unknown>;
    // Fill in any nulls from OpenGraph (OG is reliable for counts + name)
    return {
      ...built,
      full_name: built.full_name ?? og.full_name ?? null,
      bio: built.bio ?? og.bio ?? null,
      followers: built.followers ?? og.followers ?? null,
      following: built.following ?? og.following ?? null,
      posts_count: built.posts_count ?? og.posts_count ?? null,
      profile_pic_url: built.profile_pic_url ?? og.profile_pic_url ?? null,
    };
  }

  // 4. OpenGraph-only fallback (public profiles always have this)
  if (og.followers != null || og.full_name != null) {
    log.info("extractProfile: using OpenGraph fallback");
    return {
      username,
      full_name: og.full_name ?? null,
      bio: og.bio ?? null,
      followers: og.followers ?? null,
      following: og.following ?? null,
      posts_count: og.posts_count ?? null,
      is_verified: false,
      is_private: null,
      profile_pic_url: og.profile_pic_url ?? null,
      external_url: null,
      recent_posts: [],
    };
  }

  return { username, note: "Partial data — full extraction requires authenticated session_cookie" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildProfileObject(u: any, raw: any, username: string): unknown {
  return {
    username: u.username ?? username,
    full_name: u.full_name ?? null,
    bio: u.biography ?? null,
    followers: u.edge_followed_by?.count ?? u.follower_count ?? null,
    following: u.edge_follow?.count ?? u.following_count ?? null,
    posts_count: u.edge_owner_to_timeline_media?.count ?? u.media_count ?? null,
    is_verified: u.is_verified ?? raw.is_verified ?? false,
    is_private: u.is_private ?? null,
    profile_pic_url: u.profile_pic_url_hd ?? u.profile_pic_url ?? null,
    external_url: u.external_url ?? null,
    recent_posts: extractRecentPosts(u),
  };
}

function extractPost(url: string, apiPayloads: unknown[], html: string): unknown {
  // 1. Try intercepted API/GraphQL payloads
  for (const apiPayload of apiPayloads) {
    if (!apiPayload || typeof apiPayload !== "object") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = apiPayload as any;
    const media =
      p?.data?.xdt_api__v1__media__shortcode__web_info?.data?.items?.[0] ??
      p?.data?.shortcode_media ??
      p?.graphql?.shortcode_media ??
      p?.items?.[0];
    if (media) return buildPostObject(url, media);
  }

  // 2. Parse HTML in Node.js — no page.evaluate, no browser JS execution
  const media = parseMediaFromHtml(html);
  if (media) {
    const built = buildPostObject(url, media) as Record<string, unknown>;
    // If no media URLs found in the JSON blob, fall back to og:image
    if ((built.media_urls as unknown[]).length === 0) {
      const ogImage = parseMetaContent(html, "og:image");
      if (ogImage) (built.media_urls as string[]).push(ogImage);
    }
    return built;
  }

  // 3. JSON-LD parsed from raw HTML (always present, works without auth)
  const ld = parseLdJsonFromHtml(html);
  if (ld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = ld as any;
    const caption = m.description ?? m.caption ?? null;
    return {
      url,
      caption,
      likes: null,
      comments_count: null,
      media_type: m["@type"] === "VideoObject" ? "video" : "photo",
      media_urls: [m.thumbnailUrl].filter(Boolean),
      hashtags: extractHashtagsFromCaption(caption ?? ""),
      mentions: extractMentionsFromCaption(caption ?? ""),
      author: m.author?.alternateName ?? m.author?.name ?? null,
      timestamp: m.uploadDate ?? null,
    };
  }

  return { url, note: "Partial data — full extraction requires authenticated session_cookie" };
}

// ─── HTML parsers (Node.js side — no browser JS execution) ───────────────────

function parseJsonScriptsFromHtml(html: string): unknown[] {
  const results: unknown[] = [];
  const re = /<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try { results.push(JSON.parse(m[1])); } catch { /* skip malformed */ }
  }
  return results;
}

function parseLdJsonFromHtml(html: string): unknown | null {
  const m = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findInObject(obj: any, predicate: (o: any) => boolean, depth = 0): any | null {
  if (depth > 15 || obj === null || typeof obj !== "object") return null;
  if (predicate(obj)) return obj;
  const children: unknown[] = Array.isArray(obj) ? obj : Object.values(obj);
  for (const child of children) {
    const result = findInObject(child, predicate, depth + 1);
    if (result) return result;
  }
  return null;
}

// A real profile object has follower/bio/media fields — NOT just a username field
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isRealProfileObject(o: any): boolean {
  return (
    typeof o?.username === "string" &&
    (o.follower_count != null ||
      o.edge_followed_by != null ||
      o.media_count != null ||
      o.edge_owner_to_timeline_media != null ||
      (o.biography != null && typeof o.is_private === "boolean"))
  );
}

// Collect every object matching predicate across the entire tree (no early-exit on first match)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectAllMatching(obj: any, predicate: (o: any) => boolean, out: any[], depth: number): void {
  if (depth > 15 || obj === null || typeof obj !== "object") return;
  if (predicate(obj)) {
    out.push(obj);
    return; // don't recurse inside a matching node
  }
  const children: unknown[] = Array.isArray(obj) ? obj : Object.values(obj);
  for (const child of children) {
    collectAllMatching(child, predicate, out, depth + 1);
  }
}

function parseUserFromHtml(html: string, targetUsername: string): unknown | null {
  const target = targetUsername.toLowerCase();
  const blobs = parseJsonScriptsFromHtml(html);

  // Pass 1: known fast paths (avoids full recursive scan when structure is standard)
  for (const d of blobs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = d as any;
    const direct =
      p?.data?.xdt_api__v1__users__web_profile_info__connection?.data?.user ??
      p?.data?.user?.result?.legacy ??
      p?.data?.user?.result ??
      p?.data?.user ??
      p?.graphql?.user ??
      p?.user;
    if (direct?.username?.toLowerCase() === target) return direct;
  }

  // Pass 2: collect ALL real profile objects from all blobs, then filter by target username
  // (Instagram embeds both the logged-in viewer and the target user in the page blobs)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allProfiles: any[] = [];
  for (const d of blobs) {
    collectAllMatching(d, isRealProfileObject, allProfiles, 0);
  }

  const exact = allProfiles.find((p) => p.username?.toLowerCase() === target);
  if (exact) return exact;

  // No exact username match — don't return a different user
  return null;
}

function parseMetaContent(html: string, property: string): string | null {
  const m =
    html.match(new RegExp(`<meta[^>]+property="${property}"[^>]+content="([^"]*)"`, "i")) ??
    html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${property}"`, "i"));
  return m ? decodeHtmlEntities(m[1]) : null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// Fallback: Open Graph meta tags are server-rendered and always present, no JS needed
function parseProfileFromOpenGraph(html: string): Partial<{
  full_name: string | null; followers: number | null; following: number | null;
  posts_count: number | null; bio: string | null; profile_pic_url: string | null;
}> {
  const title = parseMetaContent(html, "og:title");
  const desc = parseMetaContent(html, "og:description");
  const image = parseMetaContent(html, "og:image");

  // og:title: "ScrapeTech (@scrapetech) • Instagram photos and videos"
  const nameMatch = title?.match(/^(.+?)\s*\(@/);

  // og:description format varies — try multiple patterns:
  // "1,234 Followers, 567 Following, 89 Posts - bio text"
  // "89 Posts, 1,234 Followers, 567 Following"
  // "1.234 seguidores, 567 seguindo, 89 publicações"  (pt-BR)
  const toNum = (s: string | undefined) => (s ? parseInt(s.replace(/[.,]/g, "").replace(/\D.*/, ""), 10) : null);

  // Handles both EN ("123 Followers") and PT-BR ("123 seguidores")
  const followersMatch = desc?.match(/([\d.,]+)\s*(?:Followers?|seguidores?)/i);
  // Handles EN ("123 Following") and PT-BR ("seguindo 123" — number comes after the word)
  const followingMatch =
    desc?.match(/([\d.,]+)\s*Following/i) ??
    desc?.match(/seguindo\s+([\d.,]+)/i);
  const postsMatch = desc?.match(/([\d.,]+)\s*(?:Posts?|publica[çc][oõ]es?)/i);

  // Bio is text after the stats separator (dash, en-dash, or em-dash)
  // Exclude generic "See/Veja..." Instagram fallback text
  const bioMatch = desc?.match(/(?:Posts?|publica[çc][oõ]es?)[^\-–—]*[-–—]\s*([\s\S]+?)(?:\s+(?:on|no) Instagram|$)/i);
  const bioRaw = bioMatch?.[1]?.trim() ?? null;
  const isGenericBio = !bioRaw || /^(?:See Instagram|Veja as fotos|See photos)/i.test(bioRaw);
  const bio = isGenericBio ? null : bioRaw;

  return {
    full_name: nameMatch?.[1]?.trim() ?? null,
    followers: toNum(followersMatch?.[1]),
    following: toNum(followingMatch?.[1]),
    posts_count: toNum(postsMatch?.[1]),
    bio,
    profile_pic_url: image ?? null,
  };
}

function parseMediaFromHtml(html: string): unknown | null {
  for (const d of parseJsonScriptsFromHtml(html)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = d as any;
    const direct =
      p?.data?.xdt_api__v1__media__shortcode__web_info?.data?.items?.[0] ??
      p?.data?.shortcode_media ??
      p?.items?.[0];
    if (direct?.taken_at || direct?.taken_at_timestamp || direct?.caption) return direct;

    // Recursive search for a media item object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = findInObject(p, (o: any) =>
      (o?.taken_at != null || o?.taken_at_timestamp != null) &&
      (o?.caption != null || o?.user != null || o?.owner != null)
    );
    if (found) return found;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPostObject(url: string, media: any): unknown {
  const caption =
    media.edge_media_to_caption?.edges?.[0]?.node?.text ??
    media.caption?.text ??
    (typeof media.caption === "string" ? media.caption : null);
  return {
    url,
    caption,
    likes: media.edge_media_preview_like?.count ?? media.like_count ?? null,
    comments_count: media.edge_media_to_comment?.count ?? media.comment_count ?? null,
    media_type: media.__typename === "GraphVideo" || media.media_type === 2 ? "video" : "photo",
    media_urls: extractMediaUrls(media),
    hashtags: extractHashtagsFromCaption(caption ?? ""),
    mentions: extractMentionsFromCaption(caption ?? ""),
    author: media.owner?.username ?? media.user?.username ?? null,
    timestamp: media.taken_at_timestamp
      ? new Date(media.taken_at_timestamp * 1000).toISOString()
      : media.taken_at
        ? new Date(media.taken_at * 1000).toISOString()
        : null,
  };
}

// Wait up to maxMs for apiPayloads to have more than minCount entries
async function waitForPayloads(page: any, apiPayloads: unknown[], minCount: number, maxMs: number): Promise<void> {
  const step = 500;
  let elapsed = 0;
  while (apiPayloads.length <= minCount && elapsed < maxMs) {
    await (page as any).waitForTimeout(step); // eslint-disable-line @typescript-eslint/no-explicit-any
    elapsed += step;
  }
}

async function extractHashtag(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  hashtag: string,
  limit: number,
  apiPayloads: unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any
): Promise<unknown> {
  // Wait up to 3s for GraphQL payloads — Instagram redirects /explore/tags/ to the
  // search page; GraphQL with post edges fires quickly if at all.
  await waitForPayloads(page, apiPayloads, 1, 3_000);
  log.info("extractHashtag: after wait", { payloads: apiPayloads.length });

  const posts = extractPostList(apiPayloads, limit);
  if (posts.length > 0) return { hashtag, total_found: posts.length, posts };

  // Fallback: URL-only from rendered HTML anchors
  const html: string = await (page as any).content(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const htmlPosts = parsePostLinksFromHtml(html, limit);
  log.info("extractHashtag: html-link fallback", { posts: htmlPosts.length });
  return { hashtag, total_found: htmlPosts.length, posts: htmlPosts };
}

async function extractSearch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  query: string,
  limit: number,
  apiPayloads: unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any
): Promise<unknown> {
  // Instagram's /explore/search/ page only triggers the search API on user interaction, not
  // on direct URL navigation. Skip the wait and go directly to the topsearch API endpoint.
  log.info("extractSearch: navigating to topsearch API endpoint");
  const apiUrl = `https://www.instagram.com/api/v1/web/search/topsearch/?query=${encodeURIComponent(query)}&context=blended&include_reel=false`;
  await (page as any).goto(apiUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
  await (page as any).waitForTimeout(1000); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Response listener captures JSON automatically; fallback: parse <pre> in Chrome's JSON view
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!apiPayloads.some((p: any) => Array.isArray((p as any)?.users))) {
    const apiHtml: string = await (page as any).content(); // eslint-disable-line @typescript-eslint/no-explicit-any
    const preMatch = apiHtml.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (preMatch) {
      try { apiPayloads.push(JSON.parse(preMatch[1])); } catch { /* malformed */ }
    }
  }
  log.info("extractSearch: payloads after API nav", { payloads: apiPayloads.length });

  // Extract users from topsearch response: { users: [{ user: {...} }], ... }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const users: unknown[] = [];
  for (const payload of apiPayloads) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;
    if (Array.isArray(p?.users)) {
      for (const entry of p.users) {
        const u = entry?.user ?? entry;
        if (!u?.username) continue;
        // topsearch rarely includes follower_count; try common fields
        const followers =
          u.follower_count ??
          u.edge_followed_by?.count ??
          (typeof entry?.social_context === "string"
            ? parseInt(entry.social_context.replace(/\D/g, ""), 10) || null
            : null) ??
          null;
        users.push({
          username: u.username,
          full_name: u.full_name ?? null,
          followers,
          is_verified: u.is_verified ?? false,
          profile_pic_url: u.profile_pic_url ?? null,
        });
        if (users.length >= limit) break;
      }
    }
    if (users.length >= limit) break;
  }

  const posts = extractPostList(apiPayloads, limit);
  log.info("extractSearch: result", { users: users.length, posts: posts.length });

  return { query, users, posts };
}

// Parse post shortcode links from static HTML — no browser JS needed
function parsePostLinksFromHtml(html: string, limit: number): unknown[] {
  const seen = new Set<string>();
  const results: unknown[] = [];
  const re = /href="(\/p\/[A-Za-z0-9_-]+\/)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({
      url: `https://www.instagram.com${href}`,
      caption: null,
      media_type: "photo",
      thumbnail_url: null,
      likes: null,
      comments_count: null,
      author: null,
      timestamp: null,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function extractPostList(apiPayloads: unknown[], limit: number): unknown[] {
  for (const apiPayload of apiPayloads) {
    if (apiPayload && typeof apiPayload === "object") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = apiPayload as any;
      const edges =
        p?.data?.hashtag?.edge_hashtag_to_media?.edges ??
        p?.data?.hashtag?.edge_hashtag_to_top_posts?.edges ??
        p?.data?.hashtag?.recent?.sections ??
        p?.data?.hashtag?.top?.sections ??
        p?.data?.top?.sections ??
        p?.data?.recent?.sections ??
        p?.items ??
        [];
      if (Array.isArray(edges) && edges.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return edges.slice(0, limit).map((e: any) => {
          const node = e.node ?? e;
          const caption =
            node.edge_media_to_caption?.edges?.[0]?.node?.text ??
            node.caption?.text ??
            (typeof node.caption === "string" ? node.caption : null);
          const thumbnail =
            node.display_url ??
            node.image_versions2?.candidates?.[0]?.url ??
            null;
          return {
            url: `https://www.instagram.com/p/${node.shortcode ?? node.code}/`,
            caption,
            thumbnail_url: thumbnail,
            likes: node.edge_media_preview_like?.count ?? node.like_count ?? null,
            comments_count: node.edge_media_to_comment?.count ?? node.comment_count ?? null,
            media_type: node.__typename === "GraphVideo" || node.media_type === 2 ? "video" : "photo",
            author: node.owner?.username ?? node.user?.username ?? null,
            timestamp: node.taken_at_timestamp
              ? new Date(node.taken_at_timestamp * 1000).toISOString()
              : node.taken_at
                ? new Date(node.taken_at * 1000).toISOString()
                : null,
          };
        });
      }
    }
  }
  return [];
}

// ─── Utility ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRecentPosts(user: any): unknown[] {
  const edges = user.edge_owner_to_timeline_media?.edges ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return edges.slice(0, 12).map((e: any) => ({
    url: `https://instagram.com/p/${e.node?.shortcode}/`,
    caption: e.node?.edge_media_to_caption?.edges?.[0]?.node?.text ?? null,
    likes: e.node?.edge_media_preview_like?.count ?? null,
    comments_count: e.node?.edge_media_to_comment?.count ?? null,
    media_type: e.node?.__typename === "GraphVideo" ? "video" : "photo",
    timestamp: e.node?.taken_at_timestamp
      ? new Date(e.node.taken_at_timestamp * 1000).toISOString()
      : null,
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMediaUrls(media: any): string[] {
  // Carousel / sidecar — GraphQL format
  if (media.edge_sidecar_to_children?.edges) {
    return media.edge_sidecar_to_children.edges
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) =>
        e.node?.display_url ??
        e.node?.video_url ??
        e.node?.image_versions2?.candidates?.[0]?.url ?? ""
      )
      .filter(Boolean);
  }
  // Carousel — REST API format
  if (Array.isArray(media.carousel_media)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return media.carousel_media
      .map((m: any) =>
        m.display_url ??
        m.video_url ??
        m.image_versions2?.candidates?.[0]?.url ?? ""
      )
      .filter(Boolean);
  }
  // Single media — try all known URL fields
  const url =
    media.display_url ??
    media.video_url ??
    media.image_versions2?.candidates?.[0]?.url ??
    null;
  return url ? [url] : [];
}

function extractHashtagsFromCaption(caption: string): string[] {
  return caption.match(/#[\wÀ-ɏ]+/g) ?? [];
}

function extractMentionsFromCaption(caption: string): string[] {
  // Allow dots and underscores in usernames (e.g. @kagaro.nomuro)
  return caption.match(/@[\w.]+/g) ?? [];
}
