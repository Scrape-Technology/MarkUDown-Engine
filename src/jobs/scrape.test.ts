import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../engine/orchestrator.js", () => ({
  extract: vi.fn(),
}));
vi.mock("../processors/html-cleaner.js", () => ({
  cleanHtml: vi.fn(),
}));
vi.mock("../processors/markdown-client.js", () => ({
  convertToMarkdown: vi.fn(),
}));
vi.mock("../utils/llm-fetch.js", () => ({
  llmFetch: vi.fn(),
}));
vi.mock("../utils/cache.js", () => ({
  getOrCompute: vi.fn(),
}));

import { processScrapeJob } from "./scrape.js";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { getOrCompute } from "../utils/cache.js";

function fakeJob(data: any) {
  return { id: "job-1", data } as any;
}

describe("processScrapeJob — cache/single-flight integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (extract as ReturnType<typeof vi.fn>).mockResolvedValue({
      html: "<html><body>hi</body></html>",
      statusCode: 200,
      source: "cheerio",
    });
    (cleanHtml as ReturnType<typeof vi.fn>).mockResolvedValue({
      html: "<p>hi</p>",
      links: [],
      title: "Title",
      description: "Desc",
    });
    (convertToMarkdown as ReturnType<typeof vi.fn>).mockResolvedValue("hi");
  });

  it("cache disabled: never calls getOrCompute, runs the real extraction path directly", async () => {
    const result = await processScrapeJob(fakeJob({ url: "https://example.com" }));

    expect(getOrCompute).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.data.markdown).toBe("hi");
  });

  it("cache enabled: routes through getOrCompute instead of calling extract directly", async () => {
    (getOrCompute as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string, _opts: unknown, _ttl: number, compute: () => Promise<unknown>) => ({
        data: await compute(),
        fromCache: false,
      })
    );

    const result = await processScrapeJob(fakeJob({ url: "https://example.com", options: { cache: { enabled: true } } }));

    expect(getOrCompute).toHaveBeenCalledOnce();
    expect(getOrCompute).toHaveBeenCalledWith(
      "https://example.com",
      { cache: { enabled: true } },
      3600,
      expect.any(Function),
    );
    // getOrCompute's mock implementation above actually invoked the real
    // doScrape() closure, proving the wiring is correct end to end.
    expect(extract).toHaveBeenCalledOnce();
    expect(result.data.markdown).toBe("hi");
  });

  it("cache enabled with a custom maxAge: forwarded to getOrCompute's ttlSeconds", async () => {
    (getOrCompute as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { markdown: "cached" }, fromCache: true });

    await processScrapeJob(fakeJob({ url: "https://example.com", options: { cache: { enabled: true, maxAge: 120 } } }));

    expect(getOrCompute).toHaveBeenCalledWith("https://example.com", expect.anything(), 120, expect.any(Function));
    // A cache hit/coalesced result shouldn't re-run the real extraction.
    expect(extract).not.toHaveBeenCalled();
  });
});
