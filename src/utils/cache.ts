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
