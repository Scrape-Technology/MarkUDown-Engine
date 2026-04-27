import { Job } from "bullmq";
import { isAbrasioAvailable, openAbrasioPersistentPage } from "../engine/abrasio-engine.js";
import { getCtxForCountry } from "../engine/playwright-engine.js";
import { inferCountryFromUrl } from "../utils/proxy-region.js";
import { parseCookieString } from "./instagram.js";
import { childLogger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface XJobData {
  resource: "profile" | "post" | "search";
  target: string;
  limit?: number;
  session_cookie?: string;
}

export interface XJobResult {
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

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

export function isXLoginRedirect(url: string): boolean {
  return url.includes("/i/flow/login") || url.includes("/login");
}

export function buildXUrl(resource: string, target: string): string {
  switch (resource) {
    case "profile":
      return `https://x.com/${target}`;
    case "search":
      return `https://x.com/search?q=${encodeURIComponent(target)}&src=typed_query&f=top`;
    case "post":
    default:
      return target.startsWith("http") ? target : `https://x.com/${target}`;
  }
}

// Used by the Python API layer (routes/ai.py) to validate credits before dispatch.
export function computeXCredits(resource: string, limit: number): number {
  if (resource === "profile" || resource === "post") return 1;
  return Math.max(1, Math.ceil(limit / 10));
}

export function parseXTimestamp(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new Date(raw).toISOString();
  } catch {
    return null;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 5_000;

export async function processXJob(job: Job<XJobData>): Promise<XJobResult> {
  const log = childLogger({ jobId: job.id, queue: "x" });
  const start = Date.now();
  const { resource, target, limit = 20, session_cookie } = job.data;

  log.info("X job started", { resource, target: target.slice(0, 80) });

  const targetUrl = buildXUrl(resource, target);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;
  let closeBrowser: () => Promise<void>;

  if (isAbrasioAvailable()) {
    log.info("X using Abrasio stealth browser");
    const abrasio = await openAbrasioPersistentPage(targetUrl, TIMEOUT_MS);
    page = abrasio.page;
    closeBrowser = abrasio.close;
  } else {
    log.info("X using Patchright browser");
    const country = inferCountryFromUrl(targetUrl);
    const persistCtx = await getCtxForCountry(country);
    // Use persistCtx.newPage() — reuses the persistent browser profile (history, fingerprint,
    // localStorage) so X doesn't flag the session as a fresh bot context.
    page = await persistCtx.newPage();
    closeBrowser = async () => {
      await page.close().catch(() => {});
    };
  }

  try {
    if (session_cookie) {
      // X requires cookies on both .x.com and .twitter.com (legacy compatibility)
      const xCookies = parseCookieString(session_cookie, ".x.com");
      const twitterCookies = parseCookieString(session_cookie, ".twitter.com");
      await (page as any).context().addCookies([...xCookies, ...twitterCookies]); // eslint-disable-line @typescript-eslint/no-explicit-any
      log.info("Session cookies injected for X");
    }

    // Listen to X GraphQL responses passively — no route interception, no re-fetch.
    // route.fetch() sends a second request which X flags as bot behaviour.
    // All content (profiles, posts, search) flows through /i/api/graphql/.
    const graphqlPayloads: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (page as any).on("response", async (response: any) => {
      try {
        const url: string = response.url();
        if (!url.includes("x.com/i/api/graphql") && !url.includes("twitter.com/i/api/graphql")) return;
        const ct: string = response.headers()["content-type"] ?? "";
        if (!ct.includes("application/json")) return;
        const body = await response.json().catch(() => null);
        if (body) graphqlPayloads.push(body);
      } catch { /* ignore */ }
    });

    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) {
        log.info("Retrying after rate limit delay", { attempt });
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }

      await job.updateProgress({ phase: "navigating", pct: 20 });
      // Use "load" so the JS bundle is fully downloaded before React hydrates and fires GraphQL.
      await (page as any).goto(targetUrl, { waitUntil: "load", timeout: TIMEOUT_MS }); // eslint-disable-line @typescript-eslint/no-explicit-any

      const currentUrl: string = (page as any).url(); // eslint-disable-line @typescript-eslint/no-explicit-any
      log.info("Navigated", { url: currentUrl });

      if (isXLoginRedirect(currentUrl)) {
        if (session_cookie) {
          return {
            success: false,
            resource,
            blocked: true,
            session_invalid: true,
            message: "X rejected the session cookie. Ensure auth_token and ct0 are valid.",
            processing_time_ms: Date.now() - start,
          };
        }
        return {
          success: false,
          resource,
          blocked: true,
          session_required: true,
          message: "X requires authentication. Provide session_cookie with auth_token and ct0.",
          processing_time_ms: Date.now() - start,
        };
      }

      await job.updateProgress({ phase: "extracting", pct: 60 });
      // Wait for at least 1 GraphQL payload — X is a React SPA that fires GraphQL after hydration.
      // Without this, graphqlPayloads is empty and extraction returns nothing.
      await waitForXPayloads(page, graphqlPayloads, 15_000);
      log.info("X payloads captured", {
        count: graphqlPayloads.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dataKeys: graphqlPayloads.map((p: any) => Object.keys(p?.data ?? {}).join(",")),
      });

      const html: string = await (page as any).content(); // eslint-disable-line @typescript-eslint/no-explicit-any

      // Rate limit: X error code 88 = rate limit exceeded
      if (html.includes('"code":88') || html.includes('"code": 88')) {
        if (attempt < 2) {
          log.warn("X rate limited, will retry", { attempt });
          continue;
        }
        return {
          success: false,
          resource,
          rate_limited: true,
          message: "X rate limited this request. Try again later.",
          processing_time_ms: Date.now() - start,
        };
      }

      if (html.includes('"UserUnavailable"') || html.includes("This account doesn")) {
        return {
          success: false,
          resource,
          not_found: true,
          message: "Resource not found: account suspended, deleted, or does not exist.",
          processing_time_ms: Date.now() - start,
        };
      }

      await job.updateProgress({ phase: "parsing", pct: 80 });

      const data = extractXData(resource, target, limit, graphqlPayloads);

      await job.updateProgress({ phase: "done", pct: 100 });
      log.info("X job completed", { resource, ms: Date.now() - start });

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
    message: "X rate limited this request after 2 retries.",
    processing_time_ms: Date.now() - start,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForXPayloads(page: any, payloads: unknown[], maxMs: number): Promise<void> {
  const step = 500;
  let elapsed = 0;
  // Wait for first payload (analytics/tracking may arrive before content calls)
  while (payloads.length === 0 && elapsed < maxMs) {
    await (page as any).waitForTimeout(step); // eslint-disable-line @typescript-eslint/no-explicit-any
    elapsed += step;
  }
  // Give extra settle time for the actual content GraphQL call (TweetDetail, UserByScreenName)
  // which typically arrives 1-2 calls after the first payload
  if (payloads.length > 0) {
    await (page as any).waitForTimeout(2000); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

// ─── Extraction ──────────────────────────────────────────────────────────────

// Recursively find screen_name within a tweet's user/core object.
// X sometimes nests user data behind TweetWithVisibilityResults or UserUnavailable wrappers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findScreenName(obj: any, depth = 0): string | null {
  if (depth > 6 || obj === null || typeof obj !== "object") return null;
  if (typeof obj.screen_name === "string" && obj.screen_name) return obj.screen_name;
  for (const val of Object.values(obj)) {
    const found = findScreenName(val, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractXData(
  resource: string,
  target: string,
  limit: number,
  payloads: unknown[]
): unknown {
  switch (resource) {
    case "profile":
      return extractXProfile(target, payloads);
    case "post":
      return extractXPost(target, payloads);
    case "search":
      return extractXSearch(target, limit, payloads);
    default:
      return null;
  }
}

function extractXProfile(username: string, payloads: unknown[]): unknown {
  for (const payload of payloads) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;
    // UserByScreenName GraphQL response shape
    const user = p?.data?.user?.result ?? p?.data?.user;
    if (!user) continue;
    const legacy = user.legacy ?? user;
    return {
      username: legacy.screen_name ?? username,
      display_name: legacy.name ?? null,
      bio: legacy.description ?? null,
      followers: legacy.followers_count ?? null,
      following: legacy.friends_count ?? null,
      tweets_count: legacy.statuses_count ?? null,
      is_verified: legacy.verified ?? user.is_blue_verified ?? false,
      profile_pic_url: legacy.profile_image_url_https?.replace("_normal", "_400x400") ?? null,
      website: legacy.url ?? legacy.entities?.url?.urls?.[0]?.expanded_url ?? null,
      joined: legacy.created_at ? parseXTimestamp(legacy.created_at)?.slice(0, 7) : null,
      recent_posts: extractRecentTweets(user, payloads),
    };
  }
  return { username, note: "Partial data — session_cookie required for full profile extraction" };
}

function extractXPost(url: string, payloads: unknown[]): unknown {
  for (const payload of payloads) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;

    // Path 1: TweetDetail threaded conversation — always has core.user_results (author data)
    const instructions: unknown[] =
      p?.data?.threaded_conversation_with_injections_v2?.timeline?.instructions ?? [];
    for (const inst of instructions) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries: unknown[] = (inst as any)?.entries ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tweetEntry = entries.find((e: any) => e?.content?.itemContent?.tweet_results?.result);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outer = (tweetEntry as any)?.content?.itemContent?.tweet_results?.result;
      if (!outer) continue;
      const tweet = outer.__typename === "TweetWithVisibilityResults" ? outer.tweet : outer;
      return buildPostFromPayload(url, tweet, outer);
    }

    // Path 2: newer X API — data.tweetResult.result (direct single-tweet response, may lack core)
    const direct = p?.data?.tweetResult?.result;
    if (direct) {
      const tweet = direct.__typename === "TweetWithVisibilityResults" ? direct.tweet : direct;
      return buildPostFromPayload(url, tweet, direct);
    }
  }
  return { url, note: "Partial data — session_cookie required for post extraction" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPostFromPayload(url: string, tweet: any, outer?: any): unknown {
  const legacy = tweet.legacy ?? {};
  // author (core) may live on the outer result when tweet was unwrapped from TweetWithVisibilityResults
  const authorLegacy = tweet.core?.user_results?.result?.legacy ??
    outer?.core?.user_results?.result?.legacy ?? {};
  // Recursive fallback: finds screen_name regardless of exact nesting (handles UserUnavailable wrappers etc.)
  const screenName = authorLegacy.screen_name ?? findScreenName(tweet.core ?? outer?.core) ??
    url.match(/x\.com\/([^/?]+)\/status\//)?.[1] ?? null;
  return {
    url,
    text: legacy.full_text ?? null,
    author: screenName,
    author_display_name: authorLegacy.name ?? null,
    likes: legacy.favorite_count ?? null,
    retweets: legacy.retweet_count ?? null,
    replies: legacy.reply_count ?? null,
    views: parseInt(tweet.views?.count ?? "0", 10) || null,
    media_urls: extractTweetMediaUrls(legacy),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hashtags: (legacy.entities?.hashtags ?? []).map((h: any) => `#${h.text}`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mentions: (legacy.entities?.user_mentions ?? []).map((m: any) => `@${m.screen_name}`),
    timestamp: parseXTimestamp(legacy.created_at),
  };
}

function extractXSearch(query: string, limit: number, payloads: unknown[]): unknown {
  const posts: unknown[] = [];
  for (const payload of payloads) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;
    // SearchTimeline GraphQL response shape
    const instructions =
      p?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
    if (!Array.isArray(instructions)) continue;
    for (const inst of instructions) {
      const entries = inst.entries ?? inst.moduleItems ?? [];
      for (const entry of entries) {
        const outer =
          entry?.content?.itemContent?.tweet_results?.result ??
          entry?.item?.itemContent?.tweet_results?.result;
        if (!outer) continue;
        const tweet = outer.__typename === "TweetWithVisibilityResults" ? outer.tweet : outer;
        if (!tweet) continue;
        const legacy = tweet.legacy ?? {};
        const authorLegacy = tweet.core?.user_results?.result?.legacy ??
          outer.core?.user_results?.result?.legacy ?? {};
        const screenName: string | null = authorLegacy.screen_name ??
          findScreenName(tweet.core ?? outer.core) ?? null;
        const postUrl = screenName
          ? `https://x.com/${screenName}/status/${legacy.id_str}`
          : `https://x.com/i/web/status/${legacy.id_str}`;
        posts.push({
          url: postUrl,
          text: legacy.full_text ?? null,
          author: screenName,
          likes: legacy.favorite_count ?? null,
          retweets: legacy.retweet_count ?? null,
          replies: legacy.reply_count ?? null,
          views: parseInt(tweet.views?.count ?? "0", 10) || null,
          timestamp: parseXTimestamp(legacy.created_at),
        });
        if (posts.length >= limit) break;
      }
      if (posts.length >= limit) break;
    }
    if (posts.length >= limit) break;
  }

  return { query, total_found: posts.length, posts };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRecentTweets(userResult: any, payloads: unknown[]): unknown[] {
  const tweets: unknown[] = [];
  for (const payload of payloads) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;
    const entries =
      p?.data?.user?.result?.timeline_v2?.timeline?.instructions
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ?.find((i: any) => i.type === "TimelineAddEntries")?.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const outer = entry?.content?.itemContent?.tweet_results?.result;
      if (!outer) continue;
      const tweet = outer.__typename === "TweetWithVisibilityResults" ? outer.tweet : outer;
      if (!tweet) continue;
      const legacy = tweet.legacy ?? {};
      tweets.push({
        url: `https://x.com/${userResult?.legacy?.screen_name}/status/${legacy.id_str}`,
        text: legacy.full_text ?? null,
        likes: legacy.favorite_count ?? null,
        retweets: legacy.retweet_count ?? null,
        replies: legacy.reply_count ?? null,
        views: parseInt(tweet.views?.count ?? "0", 10) || null,
        timestamp: parseXTimestamp(legacy.created_at),
      });
      if (tweets.length >= 10) break;
    }
    if (tweets.length >= 10) break;
  }
  return tweets;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTweetMediaUrls(legacy: any): string[] {
  // extended_entities has full carousel + video variants; entities.media is thumbnail-only
  const media = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return media.map((m: any) => {
    if (m.video_info?.variants?.length) {
      // Pick the highest-bitrate mp4 variant
      const mp4 = m.video_info.variants
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((v: any) => v.content_type === "video/mp4")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      return mp4[0]?.url ?? m.media_url_https ?? "";
    }
    return m.media_url_https ?? "";
  }).filter(Boolean);
}
