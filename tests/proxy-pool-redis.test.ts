// Estado do pool ISP no Redis: teto atômico (Lua) e recriação do cliente após o ioredis desistir.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { clients, createRedisClient } = vi.hoisted(() => {
  const clients: { evalFn: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn>; incr: ReturnType<typeof vi.fn> }[] = [];
  return { clients, createRedisClient: vi.fn() };
});
vi.mock("../src/utils/redis.js", () => ({ createRedisClient }));

import { config } from "../src/config.js";
import { pickIsp, _resetIspPool, CAP_WINDOW_SECONDS, CAP_PER_IP_PER_DOMAIN } from "../src/utils/proxy-pool.js";

const cfg = config as unknown as Record<string, unknown>;
let saved: unknown;

function fakeClient(broken: boolean) {
  const c = {
    evalFn: vi.fn().mockImplementation(async () => (broken ? Promise.reject(new Error("Connection is closed.")) : 1)),
    disconnect: vi.fn(),
    exists: vi.fn().mockResolvedValue(0),
    incr: vi.fn().mockResolvedValue(1),
  };
  clients.push(c);
  return { eval: c.evalFn, disconnect: c.disconnect, exists: c.exists, incr: c.incr };
}

beforeEach(() => {
  saved = cfg.IPROYAL_ISP_PROXIES;
  cfg.IPROYAL_ISP_PROXIES = "192.0.2.30:12323:u:p";
  clients.length = 0;
  createRedisClient.mockReset();
  _resetIspPool();
});
afterEach(() => {
  cfg.IPROYAL_ISP_PROXIES = saved;
  vi.useRealTimers();
});

describe("proxy-pool no Redis", () => {
  it("teto: um único EVAL atômico (INCRBY + EXPIRE quando sem TTL) com as unidades reservadas", async () => {
    createRedisClient.mockImplementation(async () => fakeClient(false));
    expect(await pickIsp("low", "example.com", 7)).toBeDefined();
    const [script, nkeys, key, units, ttl, cap] = clients[0].evalFn.mock.calls[0];
    expect(script).toMatch(/INCRBY/);
    expect(script).toMatch(/EXPIRE/);
    expect(script).toMatch(/return -1/); // conditional: only increments when it fits
    expect([nkeys, key, units, ttl, cap]).toEqual([1, "proxy:cap:192.0.2.30:example.com", 7, CAP_WINDOW_SECONDS, CAP_PER_IP_PER_DOMAIN]);
  });

  it("erro do cliente => desconecta e recria um novo depois da janela de 60 s (não reusa o morto)", async () => {
    vi.useFakeTimers();
    createRedisClient.mockImplementationOnce(async () => fakeClient(true)).mockImplementation(async () => fakeClient(false));
    expect(await pickIsp("low", "example.com")).toBeDefined(); // cai na memória
    expect(clients[0].disconnect).toHaveBeenCalled();
    vi.advanceTimersByTime(61_000);
    expect(await pickIsp("low", "example.com")).toBeDefined();
    expect(createRedisClient).toHaveBeenCalledTimes(2);
    expect(clients[1].evalFn).toHaveBeenCalled();
  });
});
