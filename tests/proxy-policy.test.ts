// Pool IPRoyal ISP + política de roteamento: sem rede, sem credencial real (config mutada).
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/utils/redis.js", () => ({ createRedisClient: vi.fn().mockRejectedValue(new Error("no redis")) }));

import { config } from "../src/config.js";
import {
  parseIspPool, pickIsp, markIpBlocked, isCoolingDown, maskProxy, _resetIspPool,
  CAP_PER_IP_PER_DOMAIN,
} from "../src/utils/proxy-pool.js";
import { poolsFor, resolveBrowserProxy } from "../src/utils/proxy-policy.js";

const cfg = config as unknown as Record<string, unknown>;
const CSV = [
  "144.225.28.108:12323:usr:pw:with:colon", "144.225.31.185:12323:usr:pw",
  "200.239.236.34:12323:usr:pw", "200.239.237.19:12323:usr:pw",
  "200.160.36.84:12323:usr:pw",
  "lixo", "1.2.3.4:abc:u:p",
].join(",");

beforeEach(() => {
  cfg.IPROYAL_ISP_PROXIES = CSV;
  cfg.IPROYAL_ISP_META = "";
  cfg.PROXY_URL = "http://proxy.test:9000";
  cfg.PROXY_USERNAME = "gu-country-";
  cfg.PROXY_PASSWORD = "gp";
  cfg.PROXY_STICKY_URL = "http://proxy.test:10000";
  cfg.GOOGLE_PROXY_URL = "http://g.test:10000"; cfg.GOOGLE_PROXY_USERNAME = "g"; cfg.GOOGLE_PROXY_PASSWORD = "gp";
  _resetIspPool();
});

describe("parse do pool IPRoyal", () => {
  it("ignora linhas inválidas, preserva ':' na senha e deriva cidade/trust dos 3 grupos", () => {
    const pool = parseIspPool(CSV);
    expect(pool).toHaveLength(5);
    expect(pool[0]).toMatchObject({ ip: "144.225.28.108", port: 12323, password: "pw:with:colon", city: "irece", trust: "low" });
    expect(pool.filter((p) => p.trust === "high").map((p) => p.city)).toEqual(["riodejaneiro", "riodejaneiro", "saopaulo"]);
  });
  it("IPROYAL_ISP_META sobrescreve; IP desconhecido é low", () => {
    const pool = parseIspPool("9.9.9.9:1000:u:p,144.225.28.108:12323:u:p", '{"144.225.28.108":{"city":"x","trust":"high"}}');
    expect(pool[0].trust).toBe("low");
    expect(pool[1]).toMatchObject({ city: "x", trust: "high" });
  });
  it("maskProxy nunca mostra credenciais", () => {
    expect(maskProxy({ server: "http://user:secret@h.test:1" })).toBe("http://h.test:1");
    expect(maskProxy({ ip: "1.1.1.1", port: 12323 })).toBe("1.1.1.1:12323");
  });
});

describe("tabela de política", () => {
  const p = (url: string, extra = {}) => poolsFor({ url, ...extra }).pools;
  it("roteia cada caso conforme a decisão do CEO", () => {
    expect(p("https://www.facebook.com/marketplace/saopaulo/search/?query=x")).toEqual(["geonode-sticky"]);
    expect(p("https://www.facebook.com/ads/library/?q=x")).toEqual(["isp-low", "geonode-sticky"]);
    expect(p("https://www.amazon.com.br/s?k=x")).toEqual(["isp-high", "geonode-sticky"]);
    expect(p("https://www.carrefour.com.br/busca/x")).toEqual(["isp-high", "geonode-sticky"]);
    expect(p("https://www.enjoei.com.br/s?q=x")).toEqual(["isp-high", "geonode-sticky"]);
    expect(p("https://www.google.com/search?q=x")).toEqual(["google"]);
    expect(p("https://www.instagram.com/x/")).toEqual(["geonode-rotating"]);
    expect(p("https://x.com/y")).toEqual(["geonode-rotating"]);
    expect(p("https://shopee.com.br/", { hard: true })).toEqual(["geonode-sticky"]);
    expect(p("https://www.amazon.com.br/s?k=x", { city: "saopaulo" })).toEqual(["geonode-sticky"]); // city vence
    expect(p("https://qualquer.com/")).toEqual(["geonode-sticky"]);
  });
});

describe("resolução, round-robin, cooldown e fallback", () => {
  it("round-robin entre os IPs do nível certo (high: Rio/SP; low: M247)", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add((await resolveBrowserProxy({ url: "https://www.enjoei.com.br/s?q=x" }))!.ispIp!);
    expect(seen).toEqual(new Set(["200.239.236.34", "200.239.237.19", "200.160.36.84"]));
    const low = await resolveBrowserProxy({ url: "https://www.facebook.com/ads/library/?q=x", region: "BR" });
    expect(low?.pool).toBe("isp-low");
    expect(low?.proxy.server).toMatch(/^http:\/\/144\.225\./);
  });
  it("bloqueio => IP em cooldown é pulado; todos em cooldown => Geonode sticky", async () => {
    for (const ip of ["200.239.236.34", "200.239.237.19"]) await markIpBlocked(ip);
    expect(await isCoolingDown("200.239.236.34")).toBe(true);
    for (let i = 0; i < 4; i++) expect((await resolveBrowserProxy({ url: "https://www.amazon.com.br/s?k=x" }))!.ispIp).toBe("200.160.36.84");
    await markIpBlocked("200.160.36.84");
    const r = await resolveBrowserProxy({ url: "https://www.amazon.com.br/s?k=x" });
    expect(r).toMatchObject({ pool: "geonode-sticky", label: "http://proxy.test:10000" });
    expect(r?.ispIp).toBeUndefined();
  });
  it("teto por IP/domínio: excedido => próximo IP; sem IP => Geonode", async () => {
    cfg.IPROYAL_ISP_PROXIES = "200.160.36.84:12323:u:p";
    _resetIspPool();
    for (let i = 0; i < CAP_PER_IP_PER_DOMAIN; i++) expect(await pickIsp("high", "amazon.com.br")).toBeDefined();
    expect(await pickIsp("high", "amazon.com.br")).toBeUndefined();
    expect(await pickIsp("high", "enjoei.com.br")).toBeDefined(); // teto é por domínio
  });
  it("alvo fora do BR não usa ISP (todos são BR)", async () => {
    const r = await resolveBrowserProxy({ url: "https://www.amazon.com/s?k=x", region: "US" });
    expect(r?.pool).toBe("geonode-sticky");
  });
  it("Google usa o proxy dedicado; sem nenhum proxy aprovado => undefined (chamador falha fechado)", async () => {
    expect((await resolveBrowserProxy({ url: "https://www.google.com/search?q=x" }))?.pool).toBe("google");
    cfg.PROXY_URL = ""; cfg.PROXY_USERNAME = ""; cfg.PROXY_PASSWORD = ""; cfg.IPROYAL_ISP_PROXIES = "";
    _resetIspPool();
    expect(await resolveBrowserProxy({ url: "https://www.enjoei.com.br/s?q=x" })).toBeUndefined();
  });
});
