import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({ config: { HARD_ROUTE_DOMAINS: "shopee.com.br" } }));
vi.mock("../utils/logger.js", () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: l, childLogger: () => l };
});
vi.mock("../engine/playwright-engine.js", () => ({ takeScreenshot: vi.fn(), settlePage: vi.fn(async () => {}) }));
vi.mock("../engine/abrasio-engine.js", () => ({
  isAbrasioAvailable: vi.fn(),
  openAbrasioPersistentPage: vi.fn(),
  isCaptchaPage: vi.fn(async () => false),
  waitForCaptchaResolution: vi.fn(async () => {}),
}));

import { processScreenshotJob, screenshotBlockReason } from "./screenshot.js";
import { takeScreenshot } from "../engine/playwright-engine.js";
import { isAbrasioAvailable, openAbrasioPersistentPage } from "../engine/abrasio-engine.js";
import { EgressPolicyError } from "../utils/egress.js";

const REAL = `<html><body><h1>Produto</h1><p>${"Descrição real do anúncio. ".repeat(20)}</p></body></html>`;
// Shape of the Cloudflare WAF block page (synthetic copy).
const CF_BLOCK = `<html><head><title>Attention Required! | Cloudflare</title></head><body>
  <h1>Sorry, you have been blocked</h1><p>You are unable to access example.com</p>
  <p>Cloudflare Ray ID: 0000000000000000</p></body></html>`;

const job = (url = "https://www.example.com/item/1") => ({ id: "s1", data: { url, options: { timeout: 60 } } }) as never;
const png = (tag: string) => Buffer.from(tag);

let abrasioHtml = REAL;
const reportBlocked = vi.fn(async () => {});
const close = vi.fn(async () => {});
const abrasioPage = {
  goto: vi.fn(async () => {}),
  content: vi.fn(async () => abrasioHtml),
  screenshot: vi.fn(async () => png("abrasio")),
  waitForLoadState: vi.fn(async () => {}),
  waitForTimeout: vi.fn(async () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  abrasioHtml = REAL;
  vi.mocked(isAbrasioAvailable).mockReturnValue(true);
  vi.mocked(openAbrasioPersistentPage).mockResolvedValue({ page: abrasioPage, close, reportBlocked, egress: {} } as never);
});

describe("screenshotBlockReason (content-guard)", () => {
  it("Cloudflare block page => challenge; blank shell => empty_page; real page => none", () => {
    expect(screenshotBlockReason(CF_BLOCK)).toBe("challenge");
    expect(screenshotBlockReason("<html><body><div id=app></div></body></html>")).toBe("empty_page");
    expect(screenshotBlockReason(REAL)).toBeUndefined();
  });
});

describe("processScreenshotJob", () => {
  it("página real no Playwright: não escala, blocked=false", async () => {
    vi.mocked(takeScreenshot).mockResolvedValue({ screenshot: png("pw"), html: REAL });
    const r = await processScreenshotJob(job());
    expect(r.data).toMatchObject({ engine: "playwright", blocked: false });
    expect(r.data.block_reason).toBeUndefined();
    expect(openAbrasioPersistentPage).not.toHaveBeenCalled();
    // leaves budget for the escalation
    expect(vi.mocked(takeScreenshot).mock.calls[0][1]?.timeout).toBe(30_000);
  });

  it("Playwright pega bloqueio do Cloudflare: escala para o Abrasio e devolve a página real", async () => {
    vi.mocked(takeScreenshot).mockResolvedValue({ screenshot: png("pw"), html: CF_BLOCK });
    const r = await processScreenshotJob(job());
    expect(r.data).toMatchObject({ engine: "abrasio", blocked: false, screenshot: png("abrasio").toString("base64") });
    expect(abrasioPage.goto).toHaveBeenCalledWith("https://www.example.com/item/1", expect.objectContaining({ waitUntil: "domcontentloaded" }));
    expect(close).toHaveBeenCalled();
    expect(reportBlocked).not.toHaveBeenCalled();
  });

  it("timeout no Playwright: escala para o Abrasio", async () => {
    vi.mocked(takeScreenshot).mockRejectedValue(new Error("page.goto: Timeout 30000ms exceeded"));
    const r = await processScreenshotJob(job());
    expect(r.data.engine).toBe("abrasio");
  });

  it("bloqueado também no Abrasio: devolve com blocked=true e põe o IP em cooldown", async () => {
    vi.mocked(takeScreenshot).mockResolvedValue({ screenshot: png("pw"), html: CF_BLOCK });
    abrasioHtml = CF_BLOCK;
    const r = await processScreenshotJob(job());
    expect(r.data).toMatchObject({ engine: "abrasio", blocked: true, block_reason: "challenge" });
    expect(reportBlocked).toHaveBeenCalledTimes(1);
  });

  it("sem Abrasio: devolve a captura do Playwright sinalizada", async () => {
    vi.mocked(isAbrasioAvailable).mockReturnValue(false);
    vi.mocked(takeScreenshot).mockResolvedValue({ screenshot: png("pw"), html: CF_BLOCK });
    const r = await processScreenshotJob(job());
    expect(r.data).toMatchObject({ engine: "playwright", blocked: true, block_reason: "challenge" });
    expect(vi.mocked(takeScreenshot).mock.calls[0][1]?.timeout).toBe(60_000);
  });

  it("Abrasio falha depois de um bloqueio: devolve o Playwright sinalizado (não finge sucesso)", async () => {
    vi.mocked(takeScreenshot).mockResolvedValue({ screenshot: png("pw"), html: CF_BLOCK });
    vi.mocked(openAbrasioPersistentPage).mockRejectedValue(new Error("abrasio down"));
    const r = await processScreenshotJob(job());
    expect(r.data).toMatchObject({ engine: "playwright", blocked: true });
  });

  it("EgressPolicyError no Playwright falha fechado (não escala)", async () => {
    vi.mocked(takeScreenshot).mockRejectedValue(new EgressPolicyError("no proxy"));
    await expect(processScreenshotJob(job())).rejects.toBeInstanceOf(EgressPolicyError);
    expect(openAbrasioPersistentPage).not.toHaveBeenCalled();
  });

  it("domínio hard-route vai direto ao Abrasio com hard=true", async () => {
    const r = await processScreenshotJob(job("https://shopee.com.br/produto-1"));
    expect(takeScreenshot).not.toHaveBeenCalled();
    expect(r.data.engine).toBe("abrasio");
    expect(vi.mocked(openAbrasioPersistentPage).mock.calls[0][2]).toMatchObject({ hard: true });
  });
});
