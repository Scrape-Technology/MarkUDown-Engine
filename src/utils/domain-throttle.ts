// src/utils/domain-throttle.ts
//
// Per-domain concurrency cap, shared across the whole worker fleet via Redis
// (not per-process) — existing BullMQ concurrency limits are per QUEUE (job
// type: scrape=10, crawl=2, extract=3, ...), with zero cross-queue awareness
// that a scrape job, an extract job, and a crawl job might all be hitting the
// SAME target domain at the same moment. A burst like that looks identical to
// a real attack from the target site's point of view, regardless of which
// internal queue issued each request.
//
// Deliberately NOT a full Scrapy-AutoThrottle-style adaptive-delay algorithm
// (target_delay = latency / target_concurrency, continuously adjusted from
// every response) — that needs response-latency instrumentation wired through
// every layer (cheerio/playwright/abrasio) and every job type, a much larger
// integration surface. This is the cheaper, still-real half of that idea: a
// hard concurrency ceiling per domain, enforced at orchestrator.ts's extract()
// (blocking, fail-open after 20 s) and at the dataset job (non-blocking; defers the job). Reactive backoff on repeated 429/503
// from a domain is a natural next step on top of this, not implemented here.

import { createRedisClient } from "./redis.js";
import { logger } from "./logger.js";
import { config } from "../config.js";

import { randomUUID } from "node:crypto";

let redis: Awaited<ReturnType<typeof createRedisClient>> | null = null;
async function getRedis() {
  if (!redis) redis = await createRedisClient();
  return redis;
}
/** After ioredis gives up reconnecting the client is dead forever: drop it so the next call recreates it. */
function dropRedis(): void {
  const r = redis;
  redis = null;
  try { r?.disconnect(); } catch { /* ignore */ }
}

// Leases, not a counter: ZSET per domain, member = holder id, score = lease expiry (ms).
// A counter with a TTL corrupted itself whenever a job outlived the TTL (the key expired
// mid-job, the late DECR created -1 with no TTL and the cap rose forever). Here every holder
// owns its own entry, expired entries are swept on each acquire, a heartbeat renews the lease
// while the job runs, and release removes ONLY the caller's own entry.
const LEASE_PREFIX = "markudown:domain-lease:";
/** A crashed holder frees its slot after at most this long. */
export const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const ACQUIRE_POLL_MS = 200;
// orchestrator.extract() waiting for a domain slot gives up and proceeds anyway past this —
// an interactive request should never hang on the throttle. Queue jobs that must respect
// the cap (dataset) use tryAcquireDomainSlot() and defer themselves instead.
const ACQUIRE_MAX_WAIT_MS = 20_000;

// KEYS[1]=zset ARGV: now, expiry, holder, cap, keyTtlMs  => 1 acquired, 0 full
const ACQUIRE_LUA =
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]) " +
  "if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then " +
  "redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]) redis.call('PEXPIRE', KEYS[1], ARGV[5]) return 1 end " +
  "return 0";
// KEYS[1]=zset ARGV: expiry, holder, keyTtlMs  => 1 renewed, 0 lease was gone and was RE-ADDED
// (event loop stalled past the lease: the job is still running, so it must count again —
// may briefly exceed the cap, but the count stays truthful).
const RENEW_LUA =
  "local had = redis.call('ZSCORE', KEYS[1], ARGV[2]) " +
  "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) redis.call('PEXPIRE', KEYS[1], ARGV[3]) " +
  "if had then return 1 end return 0";

export type ReleaseFn = () => Promise<void>;
const noopRelease: ReleaseFn = async () => {};

/**
 * One non-blocking attempt. Returns a release function when a slot was taken, `null` when
 * the domain is at MAX_CONCURRENT_PER_DOMAIN. Redis unavailable => fails OPEN (no-op release):
 * the throttle must never be the reason a job cannot run.
 * ALWAYS call the release in a `finally` — it stops the heartbeat and frees the slot.
 */
export async function tryAcquireDomainSlot(domain: string): Promise<ReleaseFn | null> {
  const key = `${LEASE_PREFIX}${domain}`;
  const holder = randomUUID();
  try {
    const r = await getRedis();
    const now = Date.now();
    const ok = await r.eval(ACQUIRE_LUA, 1, key, now, now + LEASE_MS, holder, config.MAX_CONCURRENT_PER_DOMAIN, LEASE_MS * 2);
    if (Number(ok) !== 1) return null;
  } catch (err) {
    dropRedis();
    logger.debug("Domain throttle unavailable, proceeding unthrottled", { domain, error: (err as Error).message });
    return noopRelease;
  }

  const timer = setInterval(() => {
    void (async () => {
      try {
        const r = await getRedis();
        const ok = await r.eval(RENEW_LUA, 1, key, Date.now() + LEASE_MS, holder, LEASE_MS * 2);
        if (Number(ok) !== 1) logger.warn("Domain slot lease had expired before renewal (stalled event loop); re-added", { domain });
      } catch (err) {
        dropRedis();
        logger.debug("Domain slot renew error", { domain, error: (err as Error).message });
      }
    })();
  }, HEARTBEAT_MS);
  timer.unref?.();

  let released = false;
  return async () => {
    if (released) return; // idempotent
    released = true;
    clearInterval(timer);
    try {
      const r = await getRedis();
      await r.zrem(key, holder); // only our own lease
    } catch (err) {
      dropRedis();
      logger.debug("Domain slot release error", { domain, error: (err as Error).message });
    }
  };
}

/**
 * Blocking variant for orchestrator.extract(): polls tryAcquireDomainSlot() until a slot is
 * free or ACQUIRE_MAX_WAIT_MS elapses, then proceeds unthrottled (no-op release).
 */
export async function acquireDomainSlot(domain: string): Promise<ReleaseFn> {
  const deadline = Date.now() + ACQUIRE_MAX_WAIT_MS;
  for (;;) {
    const release = await tryAcquireDomainSlot(domain);
    if (release) return release;
    if (Date.now() >= deadline) {
      logger.debug("Domain slot wait timed out, proceeding unthrottled", { domain });
      return noopRelease;
    }
    await new Promise((resolve) => setTimeout(resolve, ACQUIRE_POLL_MS));
  }
}

/** Extracts a lowercased hostname from a URL, or null if the URL is unparseable. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
