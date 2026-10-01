import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// In-memory stand-in for ioredis: emulates the two lease Lua scripts (ZSET semantics) + ZREM.
class FakeRedis {
  zsets = new Map<string, Map<string, number>>();
  disconnect = vi.fn();

  private z(key: string): Map<string, number> {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    return this.zsets.get(key)!;
  }

  async eval(script: string, _n: number, key: string, ...args: (string | number)[]): Promise<number> {
    const z = this.z(key);
    if (script.includes("ZREMRANGEBYSCORE")) {
      const [now, expiry, holder, cap] = args;
      for (const [m, exp] of z) if (exp <= Number(now)) z.delete(m);
      if (z.size < Number(cap)) {
        z.set(String(holder), Number(expiry));
        return 1;
      }
      return 0;
    }
    const [expiry, holder] = args; // renew
    if (!z.has(String(holder))) return 0;
    z.set(String(holder), Number(expiry));
    return 1;
  }

  async zrem(key: string, holder: string): Promise<number> {
    return this.z(key).delete(holder) ? 1 : 0;
  }

  size(domain: string): number {
    return this.z(`markudown:domain-lease:${domain}`).size;
  }
}

let fakeRedis = new FakeRedis();
const createRedisClient = vi.fn(async () => fakeRedis);
vi.mock("./redis.js", () => ({ createRedisClient: () => createRedisClient() }));
vi.mock("../config.js", () => ({ config: { MAX_CONCURRENT_PER_DOMAIN: 2 } }));

import { acquireDomainSlot, tryAcquireDomainSlot, domainOf, LEASE_MS } from "./domain-throttle.js";

describe("domainOf", () => {
  it("extracts a lowercased hostname", () => {
    expect(domainOf("https://Example.COM/path?x=1")).toBe("example.com");
  });
  it("returns null for an unparseable URL", () => {
    expect(domainOf("not a url")).toBeNull();
  });
});

describe("domain leases", () => {
  beforeEach(() => {
    fakeRedis.zsets.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("try: up to the cap, then null; release frees only its own lease and is idempotent", async () => {
    const r1 = await tryAcquireDomainSlot("a.example");
    const r2 = await tryAcquireDomainSlot("a.example");
    expect(r1 && r2).toBeTruthy();
    expect(await tryAcquireDomainSlot("a.example")).toBeNull();
    await r1!();
    await r1!();
    expect(fakeRedis.size("a.example")).toBe(1); // r2 still held
    const r3 = await tryAcquireDomainSlot("a.example");
    expect(r3).toBeTruthy();
    await r2!();
    await r3!();
    expect(fakeRedis.size("a.example")).toBe(0);
  });

  it("long job: heartbeat keeps the lease alive past LEASE_MS, so the cap holds", async () => {
    vi.useFakeTimers();
    const r1 = await tryAcquireDomainSlot("b.example");
    const r2 = await tryAcquireDomainSlot("b.example");
    await vi.advanceTimersByTimeAsync(LEASE_MS * 5); // a 5-minute job
    expect(await tryAcquireDomainSlot("b.example")).toBeNull();
    await r1!();
    await r2!();
  });

  it("crashed holder (no heartbeat, no release) frees its slot once the lease expires", async () => {
    vi.useFakeTimers();
    const z = new Map([["dead-holder", Date.now() + LEASE_MS], ["dead-2", Date.now() + LEASE_MS]]);
    fakeRedis.zsets.set("markudown:domain-lease:c.example", z);
    expect(await tryAcquireDomainSlot("c.example")).toBeNull();
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    const r = await tryAcquireDomainSlot("c.example");
    expect(r).toBeTruthy();
    await r!();
  });

  it("blocking acquire waits for a release (orchestrator path)", async () => {
    const r1 = await acquireDomainSlot("d.example");
    const r2 = await acquireDomainSlot("d.example");
    let got = false;
    const third = acquireDomainSlot("d.example").then((r) => { got = true; return r; });
    await new Promise((r) => setTimeout(r, 450));
    expect(got).toBe(false);
    await r1();
    const r3 = await third;
    expect(got).toBe(true);
    await r2();
    await r3();
    expect(fakeRedis.size("d.example")).toBe(0);
  });

  it("Redis error => fail open (usable no-op release), dead client dropped and recreated", async () => {
    const dead = fakeRedis;
    vi.spyOn(dead, "eval").mockRejectedValueOnce(new Error("Connection is closed."));
    const r = await tryAcquireDomainSlot("e.example");
    expect(typeof r).toBe("function");
    await expect(r!()).resolves.toBeUndefined();
    expect(dead.disconnect).toHaveBeenCalled();
    fakeRedis = new FakeRedis();
    const before = createRedisClient.mock.calls.length;
    const r2 = await tryAcquireDomainSlot("e.example");
    expect(createRedisClient.mock.calls.length).toBe(before + 1);
    expect(fakeRedis.size("e.example")).toBe(1);
    await r2!();
  });
});
