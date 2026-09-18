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
// hard concurrency ceiling per domain, enforced once at the shared entry
// point (orchestrator.ts's extract()). Reactive backoff on repeated 429/503
// from a domain is a natural next step on top of this, not implemented here.

import { createRedisClient } from "./redis.js";
import { logger } from "./logger.js";
import { config } from "../config.js";

let redis: Awaited<ReturnType<typeof createRedisClient>> | null = null;
async function getRedis() {
  if (!redis) redis = await createRedisClient();
  return redis;
}

const SLOT_PREFIX = "markudown:domain-slots:";
// Safety net if a process dies while holding a slot (crash, OOM kill) — the
// counter self-heals via TTL instead of a domain being throttled forever by a
// slot nobody will ever release.
const SLOT_TTL_SECONDS = 180;
const ACQUIRE_POLL_MS = 200;
// A job waiting for a domain slot gives up and proceeds anyway past this —
// throttling should never be the reason a job hangs indefinitely or times out
// before it even starts fetching.
const ACQUIRE_MAX_WAIT_MS = 20_000;

/**
 * Acquire one of MAX_CONCURRENT_PER_DOMAIN slots for `domain`, blocking
 * (polling) until one is free or ACQUIRE_MAX_WAIT_MS elapses. Returns a
 * release function — ALWAYS call it (in a `finally`) once the request this
 * slot was reserved for has finished, success or failure.
 *
 * Fails open at every step: a Redis error, or waiting past the max, returns a
 * no-op release and lets the caller proceed unthrottled rather than blocking
 * extraction on the throttle mechanism itself.
 */
export async function acquireDomainSlot(domain: string): Promise<() => Promise<void>> {
  const key = `${SLOT_PREFIX}${domain}`;
  const noopRelease = async () => {};
  const deadline = Date.now() + ACQUIRE_MAX_WAIT_MS;

  for (;;) {
    try {
      const r = await getRedis();
      const count = await r.incr(key);
      if (count === 1) {
        // First holder for this key (or the previous slot's TTL already
        // expired) — (re)set the safety-net TTL.
        await r.expire(key, SLOT_TTL_SECONDS);
      }
      if (count <= config.MAX_CONCURRENT_PER_DOMAIN) {
        let released = false;
        return async () => {
          if (released) return; // idempotent — a caller's finally + an explicit release shouldn't double-decrement
          released = true;
          try {
            const r2 = await getRedis();
            await r2.decr(key);
          } catch (err) {
            logger.debug("Domain slot release error", { domain, error: (err as Error).message });
          }
        };
      }
      // Over the cap — undo our own increment before waiting/retrying.
      await r.decr(key);
    } catch (err) {
      logger.debug("Domain throttle unavailable, proceeding unthrottled", { domain, error: (err as Error).message });
      return noopRelease;
    }

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
