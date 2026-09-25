// Regra de egress: toda requisição a alvo sai por proxy Geonode, fail-closed.
// Sem rede, sem credencial real: config é mutado com valores falsos e restaurado.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProxyAgent } from "undici";

const { undiciFetch, stealthCtor, launchPersistentContext, abrasioCtor, echo } = vi.hoisted(() => ({
  echo: { ip: "9.9.9.9" as string | null }, // IP devolvido pelo eco do gate; null => túnel nunca sobe
  abrasioCtor: vi.fn(),
  undiciFetch: vi.fn(),
  stealthCtor: vi.fn(),
  launchPersistentContext: vi.fn(),
}));

vi.mock("undici", async (orig) => ({ ...(await orig<typeof import("undici")>()), fetch: undiciFetch }));

vi.mock("abrasio-sdk", () => ({
  StealthClient: vi.fn().mockImplementation(function (this: any, opts: unknown) {
    stealthCtor(opts);
    this.request = vi.fn().mockRejectedValue(new Error("stealth stub"));
    this.close = vi.fn();
  }),
  TLSFingerprintError: class TLSFingerprintError extends Error {},
  Abrasio: vi.fn().mockImplementation(function (this: any, opts: unknown) {
    abrasioCtor(opts);
    this.start = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
    this.newPage = vi.fn().mockImplementation(async () => ({
      close: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockImplementation(async () => { if (echo.ip === null) throw new Error("tunnel down"); }),
      evaluate: vi.fn().mockImplementation(async () => JSON.stringify({ ip: echo.ip })),
    }));
    this.isCloud = true;
  }),
}));

vi.mock("../src/utils/redis.js", () => ({ createRedisClient: vi.fn().mockRejectedValue(new Error("no redis")) }));
vi.mock("patchright", () => ({ chromium: { launchPersistentContext } }));

import { config } from "../src/config.js";
import {
  EgressPolicyError,
  abrasioEgressFor,
  assertAbrasioEgress,
  playwrightProxyFor,
  poolKeyFor,
  proxyAgentFor,
  proxyUrlFor,
} from "../src/utils/egress.js";
import { cheerioFetch } from "../src/engine/cheerio-engine.js";
import { fetchPdfAsMarkdown } from "../src/processors/pdf-parser.js";
import { fetchGotoLocation, resolveGotoLinks } from "../src/jobs/search-parsers.js";
import { _resetIspPool } from "../src/utils/proxy-pool.js";
import { getCtxForCountry } from "../src/engine/playwright-engine.js";
import { abrasioFetch, AbrasioSession, openAbrasioPersistentPage } from "../src/engine/abrasio-engine.js";

const KEYS = [
  "PROXY_URL", "PROXY_USERNAME", "PROXY_PASSWORD",
  "GOOGLE_PROXY_URL", "GOOGLE_PROXY_USERNAME", "GOOGLE_PROXY_PASSWORD",
  "REQUIRE_PROXY_EGRESS", "ABRASIO_API_KEY", "ABRASIO_API_URL", "EGRESS_HARD_HOME_ALLOWED", "PROXY_STICKY_URL", "IPROYAL_ISP_PROXIES", "PROXY_READINESS_GATE",
] as const;
const saved: Record<string, unknown> = {};
const cfg = config as unknown as Record<string, unknown>;

function noProxy() {
  cfg.PROXY_URL = ""; cfg.PROXY_USERNAME = ""; cfg.PROXY_PASSWORD = "";
  cfg.GOOGLE_PROXY_URL = ""; cfg.GOOGLE_PROXY_USERNAME = ""; cfg.GOOGLE_PROXY_PASSWORD = "";
}
function withProxy() {
  cfg.PROXY_URL = "http://proxy.test:9000";
  cfg.PROXY_USERNAME = "fakeuser-country-";
  cfg.PROXY_PASSWORD = "fakepass";
}
function withGoogleProxy() {
  cfg.GOOGLE_PROXY_URL = "http://google-proxy.test:10000";
  cfg.GOOGLE_PROXY_USERNAME = "fakegoogleuser";
  cfg.GOOGLE_PROXY_PASSWORD = "fakegooglepass";
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = cfg[k];
  noProxy();
  cfg.REQUIRE_PROXY_EGRESS = true;
  cfg.ABRASIO_API_KEY = "";
  cfg.ABRASIO_API_URL = "";
  cfg.EGRESS_HARD_HOME_ALLOWED = true;
  cfg.PROXY_STICKY_URL = "";
  cfg.IPROYAL_ISP_PROXIES = "";
  cfg.PROXY_READINESS_GATE = true;
  echo.ip = "9.9.9.9";
  _resetIspPool();
  abrasioCtor.mockReset();
  undiciFetch.mockReset();
  stealthCtor.mockReset();
  launchPersistentContext.mockReset();
});
afterEach(() => {
  for (const k of KEYS) cfg[k] = saved[k];
});

describe("REQUIRE_PROXY_EGRESS=true, sem proxy => EgressPolicyError", () => {
  it("proxyAgentFor / proxyUrlFor / playwrightProxyFor / poolKeyFor lançam erro tipado", () => {
    expect(() => proxyAgentFor("https://www.example.com.br/x")).toThrow(EgressPolicyError);
    expect(() => proxyUrlFor("https://www.example.com/")).toThrow(EgressPolicyError);
    expect(() => playwrightProxyFor("BR")).toThrow(EgressPolicyError);
    expect(() => poolKeyFor("BR")).toThrow(EgressPolicyError);
    let caught: EgressPolicyError | undefined;
    try {
      proxyAgentFor("https://www.example.com.br/x?token=SEGREDO");
    } catch (e) {
      caught = e as EgressPolicyError;
    }
    expect(caught?.code).toBe("EGRESS_POLICY_VIOLATION");
    expect(caught?.message).toContain("PROXY_URL");
    expect(caught?.message).not.toContain("SEGREDO"); // só o host, nunca a query
  });

  it("google.* NÃO cai no proxy genérico: exige GOOGLE_PROXY_* dedicado", () => {
    withProxy(); // só o proxy genérico
    expect(() => proxyAgentFor("https://www.google.com/goto?url=abc")).toThrow(/GOOGLE_PROXY_URL/);
    expect(() => poolKeyFor("GOOGLE")).toThrow(EgressPolicyError);
  });

  it("proxy parcial (falta senha) também é tratado como ausente", () => {
    cfg.PROXY_URL = "http://proxy.test:9000";
    cfg.PROXY_USERNAME = "u";
    expect(() => proxyAgentFor("https://a.com.br/")).toThrow(EgressPolicyError);
  });
});

describe("com proxy => agente/URL aplicados", () => {
  it("agente undici, URL com sufixo de país minúsculo, chave de pool = país", () => {
    withProxy();
    expect(proxyAgentFor("https://loja.it/p")).toBeInstanceOf(ProxyAgent);
    expect(proxyUrlFor("https://loja.it/p")).toContain("fakeuser-country-it");
    expect(playwrightProxyFor("BR")?.username).toBe("fakeuser-country-br");
    expect(poolKeyFor("br")).toBe("BR");
  });

  it("google.* usa o proxy dedicado GOOGLE_PROXY_*", () => {
    withProxy();
    withGoogleProxy();
    expect(proxyUrlFor("https://www.google.com/search?q=x")).toContain("google-proxy.test:10000");
    expect(poolKeyFor("GOOGLE")).toBe("GOOGLE");
    expect(playwrightProxyFor("GOOGLE")?.server).toBe("http://google-proxy.test:10000");
  });
});

describe("REQUIRE_PROXY_EGRESS=false (dev local)", () => {
  it("devolve undefined/NONE em vez de lançar", () => {
    cfg.REQUIRE_PROXY_EGRESS = false;
    expect(proxyAgentFor("https://a.com/")).toBeUndefined();
    expect(proxyUrlFor("https://a.com/")).toBeUndefined();
    expect(playwrightProxyFor("US")).toBeUndefined();
    expect(poolKeyFor("US")).toBe("NONE");
  });
});

describe("assertAbrasioEgress", () => {
  it("Abrasio local (sai pelo IP da máquina) é bloqueado; dev pode liberar", () => {
    cfg.ABRASIO_API_URL = "local";
    expect(() => assertAbrasioEgress("https://a.com/")).toThrow(EgressPolicyError);
    cfg.REQUIRE_PROXY_EGRESS = false;
    expect(() => assertAbrasioEgress("https://a.com/")).not.toThrow();
  });
  it("Abrasio cloud é permitido (egress decidido pelo abrasio-api)", () => {
    cfg.ABRASIO_API_KEY = "sk_test";
    expect(() => assertAbrasioEgress("https://a.com/")).not.toThrow();
  });
});

describe("caminhos reais falham antes de qualquer requisição", () => {
  it("cheerioFetch: nem StealthClient direto nem fetch simples", async () => {
    await expect(cheerioFetch("https://loja.com.br/p", 2000)).rejects.toBeInstanceOf(EgressPolicyError);
    expect(stealthCtor).not.toHaveBeenCalled();
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("cheerioFetch com proxy: StealthClient recebe proxy; fallback fetch recebe dispatcher", async () => {
    withProxy();
    undiciFetch.mockResolvedValue({
      status: 200,
      headers: new Map([["content-type", "text/html"]]),
      text: async () => "<html><body>" + "conteudo ".repeat(200) + "</body></html>",
    });
    await cheerioFetch("https://loja-unica-1.it/p", 2000); // stealth stub falha -> fallback
    expect(stealthCtor).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: expect.stringContaining("proxy.test:9000") }),
    );
    expect(undiciFetch.mock.calls[0][1].dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it("pdf-parser sem proxy não faz fetch", async () => {
    await expect(fetchPdfAsMarkdown("https://a.com.br/x.pdf")).rejects.toBeInstanceOf(EgressPolicyError);
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it("resolvedor de /goto do Google: sem proxy dedicado falha", async () => {
    await expect(fetchGotoLocation("https://www.google.com/goto?url=x", 1000)).rejects.toBeInstanceOf(
      EgressPolicyError,
    );
    expect(undiciFetch).not.toHaveBeenCalled();

  });

  it("resolveGotoLinks propaga EgressPolicyError (não degrada em silêncio p/ URL aproximada)", async () => {
    const raw = [
      { title: "t", url: "", snippet: "", gotoPath: "/goto?url=x", citeUrl: "https://loja.com.br/p" },
    ] as unknown as Parameters<typeof resolveGotoLinks>[0];
    await expect(resolveGotoLinks(raw, 5)).rejects.toBeInstanceOf(EgressPolicyError);
  });

  it("Patchright: getCtxForCountry sem proxy não lança navegador (nunca contexto NONE)", async () => {
    await expect(getCtxForCountry("BR")).rejects.toBeInstanceOf(EgressPolicyError);
    expect(launchPersistentContext).not.toHaveBeenCalled();
  });

  it("Patchright com proxy: contexto lançado com o proxy embutido", async () => {
    withProxy();
    launchPersistentContext.mockResolvedValue({ close: async () => {} });
    await getCtxForCountry("DE");
    const opts = launchPersistentContext.mock.calls[0][1];
    expect(opts.proxy).toMatchObject({ server: "http://proxy.test:9000", username: "fakeuser-country-de" });
  });
});

// Por último: cria o ProxyAgent "GOOGLE" (cache por país em proxy-region) — testes sem proxy vêm antes.
it("resolvedor de /goto do Google com proxy dedicado usa dispatcher", async () => {
    withGoogleProxy();
    undiciFetch.mockResolvedValue({ headers: { get: () => "https://loja.com.br/produto" } });
    await expect(fetchGotoLocation("https://www.google.com/goto?url=x", 1000)).resolves.toBe(
      "https://loja.com.br/produto",
    );
    expect(undiciFetch.mock.calls[0][1].dispatcher).toBeInstanceOf(ProxyAgent);
});

describe("Abrasio cloud: sempre proxy aprovado explícito, fail-closed", () => {
  const URL_BR = "https://www.facebook.com/marketplace/saopaulo/search/?query=x";
  beforeEach(() => { cfg.ABRASIO_API_KEY = "sk_test"; });

  it("sem proxy aprovado: abrasioFetch, AbrasioSession e openAbrasioPersistentPage falham antes de criar sessão", async () => {
    await expect(abrasioFetch(URL_BR, 1000)).rejects.toBeInstanceOf(EgressPolicyError);
    await expect(new AbrasioSession(URL_BR, {}, 1000).fetch(URL_BR)).rejects.toBeInstanceOf(EgressPolicyError);
    await expect(openAbrasioPersistentPage(URL_BR, 1000, { region: "BR" })).rejects.toBeInstanceOf(EgressPolicyError);
    expect(abrasioCtor).not.toHaveBeenCalled();
  });

  it("com proxy: o SDK recebe proxy explícito de país/cidade (nunca deixa o cloud escolher)", async () => {
    withProxy();
    const h = await openAbrasioPersistentPage(URL_BR, 1000, { region: "BR", city: "saopaulo" });
    await h.close();
    const sent = abrasioCtor.mock.calls[0][0].proxy;
    expect(sent.server).toBe("http://proxy.test:9000");
    expect(sent.username).toBe("fakeuser-country-br-city-saopaulo");
    await abrasioFetch("https://loja.com.br/p", 1000).catch(() => {});
    expect(abrasioCtor.mock.calls[1][0].proxy.username).toBe("fakeuser-country-br"); // país inferido do TLD
  });

  it("sessão de browser usa o endpoint sticky quando configurado; Cheerio/agentes seguem no rotativo", async () => {
    withProxy();
    cfg.PROXY_STICKY_URL = "http://proxy.test:10000";
    expect((await abrasioEgressFor("https://loja.com.br/p")).proxy?.server).toBe("http://proxy.test:10000");
    expect((await abrasioEgressFor("https://loja.com.br/p")).proxy?.username).toBe("fakeuser-country-br"); // mesmas credenciais
    expect(playwrightProxyFor("BR")?.server).toBe("http://proxy.test:9000");
  });

  it("proxy explícito do chamador é respeitado", async () => {
    const px = { server: "http://x:1", username: "u", password: "p" };
    expect((await abrasioEgressFor("https://a.com/", { proxy: px })).proxy).toBe(px);
  });

  it("hard (home server): padrão fecha fechado; com true segue Geonode sticky BR (nunca IP ISP nem sem proxy)", async () => {
    cfg.EGRESS_HARD_HOME_ALLOWED = false;
    withProxy();
    await expect(abrasioEgressFor("https://shopee.com.br/", { hard: true })).rejects.toBeInstanceOf(EgressPolicyError);
    await expect(abrasioFetch("https://shopee.com.br/", 1000, { hard: true })).rejects.toBeInstanceOf(EgressPolicyError);
    expect(abrasioCtor).not.toHaveBeenCalled();
    cfg.EGRESS_HARD_HOME_ALLOWED = true;
    cfg.PROXY_STICKY_URL = "http://proxy.test:10000";
    const e = await abrasioEgressFor("https://shopee.com.br/", { hard: true });
    expect(e.pool).toBe("geonode-sticky");
    expect(e.proxy?.username).toBe("fakeuser-country-br");
    cfg.PROXY_URL = ""; cfg.PROXY_USERNAME = ""; cfg.PROXY_PASSWORD = "";
    await expect(abrasioEgressFor("https://shopee.com.br/", { hard: true })).rejects.toBeInstanceOf(EgressPolicyError);
  });
});

describe("gate de prontidão do proxy (eco de IP antes de navegar ao alvo)", () => {
  const URL_AD = "https://www.facebook.com/ads/library/?q=x";
  beforeEach(() => {
    cfg.ABRASIO_API_KEY = "sk_test";
    withProxy();
  });

  it("túnel sobe: a sessão abre e a primeira navegação é o eco, não o alvo", async () => {
    const h = await openAbrasioPersistentPage(URL_AD, 1000, { region: "BR" });
    await h.close();
    expect(abrasioCtor).toHaveBeenCalledTimes(1);
  });

  it("túnel nunca sobe: falha fechado (EgressPolicyError) sem seguir ao alvo", async () => {
    vi.useFakeTimers();
    echo.ip = null;
    const p = openAbrasioPersistentPage(URL_AD, 1000, { region: "BR" });
    const assertion = expect(p).rejects.toBeInstanceOf(EgressPolicyError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    vi.useRealTimers();
  });

  it("ISP estático: IP de eco != host do proxy => falha; == host => ok", async () => {
    cfg.IPROYAL_ISP_PROXIES = "144.225.28.108:12323:u:p"; // trust low (Irecê) => Ad Library
    _resetIspPool();
    echo.ip = "1.2.3.4";
    // eco != host: o IP ISP entra em cooldown e a re-tentativa cai no Geonode (2ª sessão)
    const h = await openAbrasioPersistentPage(URL_AD, 1000, { region: "BR" });
    await h.close();
    expect(abrasioCtor).toHaveBeenCalledTimes(2);
    expect(abrasioCtor.mock.calls[0][0].proxy.server).toBe("http://144.225.28.108:12323");
    expect(abrasioCtor.mock.calls[1][0].proxy.server).toBe("http://proxy.test:9000");
    // sem Geonode para cair: falha fechado
    noProxy(); _resetIspPool(); echo.ip = "1.2.3.4";
    await expect(openAbrasioPersistentPage(URL_AD, 1000, { region: "BR" })).rejects.toBeInstanceOf(EgressPolicyError);
    withProxy();
    _resetIspPool();
    echo.ip = "144.225.28.108";
    const h2 = await openAbrasioPersistentPage(URL_AD, 1000, { region: "BR" });
    await h2.close();
    expect(abrasioCtor.mock.calls.at(-1)![0].proxy.server).toBe("http://144.225.28.108:12323");
  });
});
