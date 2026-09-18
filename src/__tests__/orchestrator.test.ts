import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../engine/cheerio-engine.js", async () => {
  // Real cheerio (not mocked) so selector-based requireContent checks run
  // against actual parsing, not a stub — only cheerioFetch (the network call)
  // needs mocking.
  const cheerio = await vi.importActual<typeof import("cheerio")>("cheerio");
  return {
    cheerioFetch: vi.fn(),
    loadCheerio: (html: string) => cheerio.load(html),
  };
});

vi.mock("../engine/playwright-engine.js", () => ({
  playwrightFetch: vi.fn(),
}));

vi.mock("../engine/abrasio-engine.js", () => ({
  abrasioFetch: vi.fn(),
  isAbrasioAvailable: vi.fn(() => false),
}));

vi.mock("../processors/pdf-parser.js", () => ({
  isPdfUrl: () => false,
  fetchPdfAsMarkdown: vi.fn(),
}));

import { extract } from "../engine/orchestrator.js";
import { cheerioFetch } from "../engine/cheerio-engine.js";
import { playwrightFetch } from "../engine/playwright-engine.js";
import { abrasioFetch, isAbrasioAvailable } from "../engine/abrasio-engine.js";

const URL = "https://example.com/product/123";

// A page whose only currency-looking text is an unrelated empty-cart subtotal
// — the exact shape confirmed live against marisa.com.br (2026-09-18): status
// 200, plenty of real text (passes hasContent), but no real price anywhere.
const THIN_PRICE_HTML = `<html><body>
  <h1>Product Title</h1>
  <p>${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(10)}</p>
  <span class="minicart-total"><span class="price">R$ 0,00</span> (Subtotal)</span>
</body></html>`;

const REAL_PRICE_HTML = `<html><body>
  <h1>Product Title</h1>
  <p>${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(10)}</p>
  <span class="product-price" data-testid="price">R$ 59,95</span>
</body></html>`;

describe("extract() requireContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isAbrasioAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it("with no requireContent, existing hasContent-only behavior is unchanged", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200, contentType: "text/html" });

    const result = await extract(URL, {});
    expect(result.source).toBe("cheerio");
    expect(result.html).toBe(THIN_PRICE_HTML);
  });

  it("pattern requireContent: Layer 1 lacking the real price escalates to Layer 2", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200, contentType: "text/html" });
    (playwrightFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: REAL_PRICE_HTML, statusCode: 200 });

    const result = await extract(URL, { requireContent: { pattern: /R\$\s?[1-9]\d*[.,]\d{2}/ } });

    expect(cheerioFetch).toHaveBeenCalledOnce();
    expect(playwrightFetch).toHaveBeenCalledOnce();
    expect(result.source).toBe("playwright");
    expect(result.html).toBe(REAL_PRICE_HTML);
  });

  it("selector requireContent: same escalation, keyed on a CSS selector instead of a regex", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200, contentType: "text/html" });
    (playwrightFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: REAL_PRICE_HTML, statusCode: 200 });

    const result = await extract(URL, { requireContent: { selector: ".product-price" } });

    expect(result.source).toBe("playwright");
  });

  it("when Layer 1 already satisfies requireContent, never calls Layer 2 at all", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: REAL_PRICE_HTML, statusCode: 200, contentType: "text/html" });

    const result = await extract(URL, { requireContent: { selector: ".product-price" } });

    expect(result.source).toBe("cheerio");
    expect(playwrightFetch).not.toHaveBeenCalled();
  });

  it("when NO layer satisfies requireContent (Abrasio unavailable), throws AllLayersFailedError instead of returning a false success", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200, contentType: "text/html" });
    (playwrightFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200 });

    await expect(
      extract(URL, { requireContent: { selector: ".product-price" } })
    ).rejects.toThrow(/failed|all layers/i);
  });

  it("when even Abrasio (the last layer) fails requireContent, throws instead of silently succeeding", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200, contentType: "text/html" });
    (playwrightFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200 });
    (isAbrasioAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (abrasioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200 });

    await expect(
      extract(URL, { requireContent: { selector: ".product-price" } })
    ).rejects.toThrow();
    expect(abrasioFetch).toHaveBeenCalledOnce();
  });

  it("forceAbrasio + requireContent: throws if the forced layer doesn't have the data either", async () => {
    (isAbrasioAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (abrasioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200 });

    await expect(
      extract(URL, { forceAbrasio: true, requireContent: { selector: ".product-price" } })
    ).rejects.toThrow();
    expect(cheerioFetch).not.toHaveBeenCalled();
  });
});
