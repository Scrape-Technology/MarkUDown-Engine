import { createRedisClient } from "./redis.js";
import { logger } from "./logger.js";
import crypto from "crypto";

let redis: Awaited<ReturnType<typeof createRedisClient>> | null = null;

async function getRedis() {
  if (!redis) {
    redis = await createRedisClient();
  }
  return redis;
}

const CACHE_PREFIX = "markudown:cache:";

function cacheKey(url: string, optionsHash: string): string {
  return `${CACHE_PREFIX}${optionsHash}:${url}`;
}

function hashOptions(options: Record<string, unknown>): string {
  const sorted = JSON.stringify(options, Object.keys(options).sort());
  return crypto.createHash("md5").update(sorted).digest("hex").slice(0, 12);
}

export interface CacheOptions {
  /** Enable cache (default false) */
  enabled?: boolean;
  /** Max cache age in seconds (default 3600 = 1 hour) */
  maxAge?: number;
}

export interface CachedResult {
  data: unknown;
  cachedAt: number;
  url: string;
}

/**
 * Get a cached scrape result for a URL + options combination.
 */
export async function getCached(
  url: string,
  scrapeOptions: Record<string, unknown>,
): Promise<CachedResult | null> {
  try {
    const r = await getRedis();
    const key = cacheKey(url, hashOptions(scrapeOptions));
    const raw = await r.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedResult;
    logger.debug("Cache hit", { url, cachedAt: parsed.cachedAt });
    return parsed;
  } catch (err) {
    logger.debug("Cache get error", { url, error: (err as Error).message });
    return null;
  }
}

/**
 * Store a scrape result in cache.
 */
export async function setCache(
  url: string,
  scrapeOptions: Record<string, unknown>,
  data: unknown,
  ttlSeconds: number = 3600,
): Promise<void> {
  try {
    const r = await getRedis();
    const key = cacheKey(url, hashOptions(scrapeOptions));
    const cached: CachedResult = { data, cachedAt: Date.now(), url };
    await r.set(key, JSON.stringify(cached), "EX", ttlSeconds);
    logger.debug("Cache set", { url, ttl: ttlSeconds });
  } catch (err) {
    logger.debug("Cache set error", { url, error: (err as Error).message });
  }
}

// ── Single-flight (request coalescing) ─────────────────────────────────────
// getCached()/setCache() alone don't stop two CONCURRENT identical requests
// (same url+options, cache enabled, both arriving before either finishes)
// from both doing the full fetch/render/convert work — there's no lock or
// in-flight tracking, just get/set around the work. A burst of duplicate
// requests for the same URL (a common real pattern: several callers hitting
// the same product page around the same time) pays N times for work that
// only needed to happen once.

const LOCK_PREFIX = "markudown:lock:";
// Safety net, not the expected duration: if the lock holder's process dies
// mid-computation, this is how long other callers wait before the lock
// expires and someone else can take over, rather than being stuck forever.
const LOCK_TTL_SECONDS = 90;
const POLL_INTERVAL_MS = 250;
// How long a waiter polls for the leader's result before giving up and
// computing independently — fail-open, never block a caller indefinitely on
// another request's behavior (a slow/hung leader shouldn't cascade into
// every waiter hanging too).
const MAX_WAIT_MS = 30_000;

/**
 * Cache-aware, single-flight wrapper: at most one caller actually runs
 * `compute()` for a given url+options at a time. Concurrent callers for the
 * same key either get the already-cached result, or wait for the in-flight
 * leader to finish and populate the cache, instead of each redoing the work.
 *
 * Degrades gracefully at every step — a Redis outage, a lock that can't be
 * acquired for the wrong reasons, or a wait that times out all fall through
 * to just calling `compute()` directly, matching the "cache always misses on
 * infra trouble" philosophy getCached()/setCache() already use.
 */
export async function getOrCompute<T>(
  url: string,
  scrapeOptions: Record<string, unknown>,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<{ data: T; fromCache: boolean }> {
  const cached = await getCached(url, scrapeOptions);
  if (cached) return { data: cached.data as T, fromCache: true };

  const lockKey = `${LOCK_PREFIX}${cacheKey(url, hashOptions(scrapeOptions))}`;
  let haveLock = false;
  try {
    const r = await getRedis();
    haveLock = (await r.set(lockKey, "1", "EX", LOCK_TTL_SECONDS, "NX")) === "OK";
  } catch (err) {
    logger.debug("Single-flight lock acquire error, proceeding without coalescing", { url, error: (err as Error).message });
  }

  if (haveLock) {
    try {
      const data = await compute();
      await setCache(url, scrapeOptions, data, ttlSeconds);
      return { data, fromCache: false };
    } finally {
      try {
        const r = await getRedis();
        await r.del(lockKey);
      } catch (err) {
        logger.debug("Single-flight lock release error", { url, error: (err as Error).message });
      }
    }
  }

  // Someone else already holds the lock and is computing this — wait for
  // their result to land in the cache instead of duplicating the work.
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const nowCached = await getCached(url, scrapeOptions);
    if (nowCached) return { data: nowCached.data as T, fromCache: true };
  }

  logger.debug("Single-flight wait timed out (leader crashed or slow), computing independently", { url });
  const data = await compute();
  await setCache(url, scrapeOptions, data, ttlSeconds);
  return { data, fromCache: false };
}

// ── Structure-analysis (selector plan) cache ───────────────────────────────
// Keyed by domain + schema + goal (NOT the full URL) — the point is to reuse a
// selector plan across different pages on the same site sharing the same
// extraction goal (paginated listings, category pages, ...), not just repeat
// visits to one exact URL. See structure-analyzer.ts's analyzeStructure().

const STRUCTURE_CACHE_PREFIX = "markudown:structure:";
const STRUCTURE_CACHE_TTL_SECONDS = 86_400; // 24h — site structures drift slowly; staleness is self-detected (see analyzeStructure)

function structureCacheKey(domain: string, schema: Record<string, string>, goal: string): string {
  const schemaKeys = Object.keys(schema).sort().join(",");
  const hash = crypto.createHash("md5").update(`${schemaKeys}\n${goal}`).digest("hex").slice(0, 12);
  return `${STRUCTURE_CACHE_PREFIX}${domain}:${hash}`;
}

export async function getCachedStructure<T>(
  domain: string,
  schema: Record<string, string>,
  goal: string,
): Promise<T | null> {
  try {
    const r = await getRedis();
    const raw = await r.get(structureCacheKey(domain, schema, goal));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.debug("Structure cache get error", { domain, error: (err as Error).message });
    return null;
  }
}

export async function setCachedStructure(
  domain: string,
  schema: Record<string, string>,
  goal: string,
  structure: unknown,
): Promise<void> {
  try {
    const r = await getRedis();
    await r.set(
      structureCacheKey(domain, schema, goal),
      JSON.stringify(structure),
      "EX",
      STRUCTURE_CACHE_TTL_SECONDS,
    );
  } catch (err) {
    logger.debug("Structure cache set error", { domain, error: (err as Error).message });
  }
}

/**
 * Delete a stale cached structure (called when the cached selectors no longer
 * match anything on a fresh page — see analyzeStructure's self-heal check).
 */
export async function invalidateCachedStructure(
  domain: string,
  schema: Record<string, string>,
  goal: string,
): Promise<void> {
  try {
    const r = await getRedis();
    await r.del(structureCacheKey(domain, schema, goal));
  } catch (err) {
    logger.debug("Structure cache invalidate error", { domain, error: (err as Error).message });
  }
}
