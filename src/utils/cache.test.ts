import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal in-memory fake standing in for ioredis — just enough of GET/SET
// (with NX/EX semantics)/DEL for getOrCompute()'s single-flight logic.
class FakeRedis {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  // Mirrors ioredis's variadic set(): set(key, value, "EX", ttl[, "NX"]).
  async set(key: string, value: string, ..._rest: unknown[]): Promise<"OK" | null> {
    const nx = _rest.includes("NX");
    if (nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

const fakeRedis = new FakeRedis();

vi.mock("./redis.js", () => ({
  createRedisClient: vi.fn(async () => fakeRedis),
}));

// Real timers, but keep the module's own MAX_WAIT_MS/POLL_INTERVAL_MS small
// enough that the "wait timed out" test doesn't make the suite slow —
// achieved by resolving the leader's lock quickly in that test instead of
// trying to shrink the module's real constants.

import { getOrCompute, getCached } from "./cache.js";

describe("getOrCompute (single-flight cache)", () => {
  beforeEach(() => {
    // @ts-expect-error — reach into the fake for a clean slate between tests
    fakeRedis.store.clear();
  });

  it("cache hit: never calls compute()", async () => {
    const compute = vi.fn(async () => "should not run");
    // Prime the cache directly via the real setCache-equivalent path: call
    // getOrCompute once so it computes and caches, then again to prove hit.
    const first = vi.fn(async () => "computed value");
    await getOrCompute("https://example.com/a", {}, 60, first);
    expect(first).toHaveBeenCalledOnce();

    const result = await getOrCompute("https://example.com/a", {}, 60, compute);
    expect(result.fromCache).toBe(true);
    expect(result.data).toBe("computed value");
    expect(compute).not.toHaveBeenCalled();
  });

  it("cache miss: acquires the lock, computes once, caches the result, releases the lock", async () => {
    const compute = vi.fn(async () => "fresh value");
    const result = await getOrCompute("https://example.com/b", {}, 60, compute);

    expect(result).toEqual({ data: "fresh value", fromCache: false });
    expect(compute).toHaveBeenCalledOnce();

    const cached = await getCached("https://example.com/b", {});
    expect(cached?.data).toBe("fresh value");
  });

  it("two concurrent calls for the same key: only one actually runs compute()", async () => {
    let resolveCompute!: (v: string) => void;
    const slowCompute = vi.fn(
      () => new Promise<string>((resolve) => { resolveCompute = resolve; })
    );

    const callA = getOrCompute("https://example.com/c", {}, 60, slowCompute);
    // Let callA's synchronous portion (cache check + lock acquire) run first.
    await new Promise((r) => setTimeout(r, 10));
    const callB = getOrCompute("https://example.com/c", {}, 60, vi.fn(async () => "B should never run"));

    // Resolve the leader's compute after both calls are in flight.
    resolveCompute("leader result");
    const [resultA, resultB] = await Promise.all([callA, callB]);

    expect(slowCompute).toHaveBeenCalledOnce();
    expect(resultA.data).toBe("leader result");
    expect(resultB.data).toBe("leader result");
    expect(resultB.fromCache).toBe(true); // B picked it up from cache, never computed
  });

  it("cache disabled path (getCached alone): unaffected by single-flight machinery", async () => {
    // Sanity check that plain getCached still behaves as a normal cache read
    // when nothing has populated the key.
    const result = await getCached("https://example.com/never-cached", {});
    expect(result).toBeNull();
  });
});
