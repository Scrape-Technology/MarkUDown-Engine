import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    PROXY_URL: "http://proxy.example.test:9000",
    PROXY_USERNAME: "user-type-residential-country-",
    PROXY_PASSWORD: "secret",
    GOOGLE_PROXY_URL: "", GOOGLE_PROXY_USERNAME: "", GOOGLE_PROXY_PASSWORD: "",
  },
}));
vi.mock("../utils/logger.js", () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: l, childLogger: () => l };
});
vi.mock("../utils/llm-fetch.js", () => ({ llmFetch: vi.fn() }));
vi.mock("../processors/html-cleaner.js", () => ({ cleanHtml: vi.fn() }));
vi.mock("../processors/markdown-client.js", () => ({ convertToMarkdown: vi.fn() }));
vi.mock("../engine/cheerio-engine.js", () => ({ cheerioFetch: vi.fn() }));
vi.mock("../engine/playwright-engine.js", () => ({ getCtxForCountry: vi.fn() }));
vi.mock("../engine/abrasio-engine.js", () => ({
  isAbrasioAvailable: vi.fn(),
  openAbrasioPersistentPage: vi.fn(),
  isCaptchaPage: vi.fn(),
  waitForCaptchaResolution: vi.fn(),
}));

import { processDatasetJob, buildAbrasioGeoOptions } from "./dataset.js";
import { cheerioFetch } from "../engine/cheerio-engine.js";
import { getCtxForCountry } from "../engine/playwright-engine.js";
import { isAbrasioAvailable, openAbrasioPersistentPage } from "../engine/abrasio-engine.js";

const job = (options?: Record<string, unknown>) =>
  ({ id: "t1", data: { url: "https://www.facebook.com/marketplace/search/?query=example-brand", goal: "g", options } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cheerioFetch).mockRejectedValue(new Error("blocked")); // hand off to the browser phase
  vi.mocked(getCtxForCountry).mockRejectedValue(new Error("stop-patchright"));
  vi.mocked(openAbrasioPersistentPage).mockRejectedValue(new Error("stop-abrasio"));
});

describe("propagacao de country/city no dataset", () => {
  it("Patchright: usa country explicito em vez da TLD (.com -> BR)", async () => {
    vi.mocked(isAbrasioAvailable).mockReturnValue(false);
    await expect(processDatasetJob(job({ country: "BR" }))).rejects.toThrow("stop-patchright");
    expect(getCtxForCountry).toHaveBeenCalledWith("BR");
    expect(vi.mocked(cheerioFetch).mock.calls[0][2]).toEqual({ country: "BR" });
  });
  it("sem country: comportamento atual (TLD .com -> US, sem geo)", async () => {
    vi.mocked(isAbrasioAvailable).mockReturnValue(false);
    await expect(processDatasetJob(job())).rejects.toThrow("stop-patchright");
    expect(getCtxForCountry).toHaveBeenCalledWith("US");
    expect(vi.mocked(cheerioFetch).mock.calls[0][2]).toEqual({});
  });
  it("country invalido e ignorado", async () => {
    vi.mocked(isAbrasioAvailable).mockReturnValue(false);
    await expect(processDatasetJob(job({ country: "BRAZIL" }))).rejects.toThrow("stop-patchright");
    expect(getCtxForCountry).toHaveBeenCalledWith("US");
  });
  it("Abrasio recebe region (e proxy de cidade quando ha city)", async () => {
    vi.mocked(isAbrasioAvailable).mockReturnValue(true);
    await expect(processDatasetJob(job({ country: "BR", city: "saopaulo" }))).rejects.toThrow("stop-abrasio");
    const opts = vi.mocked(openAbrasioPersistentPage).mock.calls[0][2] as { region?: string; proxy?: { username?: string } };
    expect(opts.region).toBe("BR");
    expect(opts.proxy?.username).toBe("user-type-residential-country-br-city-saopaulo");
  });
  it("Abrasio com country sem city tambem recebe proxy Geonode do pais", async () => {
    vi.mocked(isAbrasioAvailable).mockReturnValue(true);
    await expect(processDatasetJob(job({ country: "BR" }))).rejects.toThrow("stop-abrasio");
    const opts = vi.mocked(openAbrasioPersistentPage).mock.calls[0][2] as { region?: string; proxy?: { username?: string } };
    expect(opts.proxy?.username).toBe("user-type-residential-country-br");
  });
  it("Abrasio sem country: opcoes vazias (inalterado)", async () => {
    vi.mocked(isAbrasioAvailable).mockReturnValue(true);
    await expect(processDatasetJob(job())).rejects.toThrow("stop-abrasio");
    expect(vi.mocked(openAbrasioPersistentPage).mock.calls[0][2]).toEqual({});
  });
  it("city sem country e ignorada", () => {
    expect(buildAbrasioGeoOptions({ city: "saopaulo" })).toEqual({});
    expect(buildAbrasioGeoOptions({ country: "BR" }).region).toBe("BR");
  });
});

describe("falha fechada sem credencial de proxy", () => {
  it("country pedido e proxy ausente: erra antes de qualquer requisicao", async () => {
    const { config } = await import("../config.js");
    const saved = { ...config };
    Object.assign(config, { PROXY_URL: "", PROXY_USERNAME: "", PROXY_PASSWORD: "" });
    try {
      await expect(processDatasetJob(job({ country: "BR", city: "saopaulo" }))).rejects.toThrow(/refusing to run without proxy/);
      expect(cheerioFetch).not.toHaveBeenCalled();
      expect(getCtxForCountry).not.toHaveBeenCalled();
      expect(openAbrasioPersistentPage).not.toHaveBeenCalled();
    } finally {
      Object.assign(config, saved);
    }
  });
});
