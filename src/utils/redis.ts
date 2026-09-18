import IORedis from "ioredis";
import { config } from "../config.js";

/**
 * Create a Redis client for auxiliary storage (change detection, monitor
 * state, caching, domain throttling — NOT the BullMQ job queue connection,
 * which is a separate client in queues/connection.ts with its own retry
 * needs).
 *
 * Bounded, fail-fast retry/timeout settings — confirmed live 2026-09-18 that
 * the previous `maxRetriesPerRequest: null` made every caller hang
 * INDEFINITELY when Redis was unreachable: with ioredis's default
 * `enableOfflineQueue: true`, a command issued while disconnected is queued
 * rather than rejected, and `maxRetriesPerRequest: null` means "never give up
 * on a queued command" — so the promise from e.g. `redis.get(...)` simply
 * never resolves OR rejects. Two of this function's four callers
 * (change-detection.ts, monitor.ts, playbook-monitor.ts) have no try/catch
 * around their Redis calls at all, so that hang would have stalled a BullMQ
 * worker slot forever, not failed the job — worse than any of the
 * "best-effort, degrade gracefully" designs (cache.ts, domain-throttle.ts)
 * this was meant to support even intended. connectTimeout + a capped
 * retryStrategy + a finite maxRetriesPerRequest together bound the worst case
 * to a few seconds: after 3 failed reconnect attempts the client gives up
 * entirely, and every call thereafter now fails FAST instead of hanging.
 */
export async function createRedisClient() {
  return new IORedis(config.REDIS_URL, {
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
  });
}
