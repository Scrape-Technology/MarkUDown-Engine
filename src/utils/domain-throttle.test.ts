import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal in-memory fake standing in for ioredis — just INCR/DECR/EXPIRE,
// all acquireDomainSlot() actually uses.
class FakeRedis {
  private counters = new Map<string, number>();

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async decr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) - 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  get(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  clear(): void {
    this.counters.clear();
  }
}

const fakeRedis = new FakeRedis();

vi.mock("./redis.js", () => ({
  createRedisClient: vi.fn(async () => fakeRedis),
}));

vi.mock("../config.js", () => ({
  config: { MAX_CONCURRENT_PER_DOMAIN: 2 },
}));

import { acquireDomainSlot, domainOf } from "./domain-throttle.js";

describe("domainOf", () => {
  it("extracts a lowercased hostname", () => {
    expect(domainOf("https://Example.COM/path?x=1")).toBe("example.com");
  });

  it("returns null for an unparseable URL", () => {
    expect(domainOf("not a url")).toBeNull();
  });
});

describe("acquireDomainSlot", () => {
  beforeEach(() => {
    fakeRedis.clear();
  });

  it("acquires immediately when under the cap, release decrements back to 0", async () => {
    const release = await acquireDomainSlot("shopee.com.br");
    expect(fakeRedis.get("markudown:domain-slots:shopee.com.br")).toBe(1);

    await release();
    expect(fakeRedis.get("markudown:domain-slots:shopee.com.br")).toBe(0);
  });

  it("allows up to MAX_CONCURRENT_PER_DOMAIN (2) concurrent holders, third call waits for a release", async () => {
    const release1 = await acquireDomainSlot("marisa.com.br");
    const release2 = await acquireDomainSlot("marisa.com.br");
    expect(fakeRedis.get("markudown:domain-slots:marisa.com.br")).toBe(2);

    let acquired3 = false;
    const third = acquireDomainSlot("marisa.com.br").then((release) => {
      acquired3 = true;
      return release;
    });

    // Give the poll loop a couple of cycles to prove it's genuinely waiting,
    // not just slow to resolve.
    await new Promise((r) => setTimeout(r, 450));
    expect(acquired3).toBe(false);

    await release1();
    const release3 = await third;
    expect(acquired3).toBe(true);

    await release2();
    await release3();
    expect(fakeRedis.get("markudown:domain-slots:marisa.com.br")).toBe(0);
  });

  it("fails open (returns a usable no-op release) when Redis errors", async () => {
    // domain-throttle.ts caches its Redis client at module scope once
    // connected. Warm that cache first (self-contained, no dependency on
    // this test's position in the file) so the spy below actually targets
    // the client acquireDomainSlot will use, then make the cached client's
    // own call fail for one invocation to exercise the failure branch.
    const warmup = await acquireDomainSlot("warmup-for-fail-open-test.example");
    await warmup();
    const incrSpy = vi.spyOn(fakeRedis, "incr").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const release = await acquireDomainSlot("unreachable-redis-test.example");
    expect(typeof release).toBe("function");
    await expect(release()).resolves.toBeUndefined();

    incrSpy.mockRestore();
  });

  it("release() is idempotent — calling it twice only decrements once", async () => {
    const release = await acquireDomainSlot("idempotent-test.example");
    expect(fakeRedis.get("markudown:domain-slots:idempotent-test.example")).toBe(1);

    await release();
    await release();
    expect(fakeRedis.get("markudown:domain-slots:idempotent-test.example")).toBe(0);
  });
});
