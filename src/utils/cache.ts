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
