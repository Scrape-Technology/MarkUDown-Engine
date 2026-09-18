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
  isPdfUrl: vi.fn(() => false),
  fetchPdfAsMarkdown: vi.fn(),
}));

// Real Redis isn't available in this unit-test environment — acquireDomainSlot
// would otherwise hang trying to connect (see domain-throttle.test.ts for
// coverage of its real Redis-backed logic, with a fake client). domainOf is
// pure (no Redis), so keep the real implementation via importActual.
vi.mock("../utils/domain-throttle.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/domain-throttle.js")>("../utils/domain-throttle.js");
  return {
    ...actual,
    acquireDomainSlot: vi.fn(async () => async () => {}),
  };
});

import { extract } from "../engine/orchestrator.js";
import { cheerioFetch } from "../engine/cheerio-engine.js";
import { playwrightFetch } from "../engine/playwright-engine.js";
import { abrasioFetch, isAbrasioAvailable } from "../engine/abrasio-engine.js";
import { isPdfUrl, fetchPdfAsMarkdown } from "../processors/pdf-parser.js";

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

  // --- Regressions for the 2026-09-18 code-review findings on this feature ---

  it("forceAbrasio: an exception from callAbrasio is wrapped into AllLayersFailedError, not left to propagate raw", async () => {
    (isAbrasioAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (abrasioFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("proxy connection reset"));

    let caught: unknown;
    try {
      await extract(URL, { forceAbrasio: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe("AllLayersFailedError");
    expect((caught as Error).message).toContain("proxy connection reset");
  });

  it("a shared g-flagged RegExp instance doesn't lose matches across repeated extract() calls (stateful .lastIndex)", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: REAL_PRICE_HTML, statusCode: 200, contentType: "text/html" });
    // A single shared pattern object, the way a caller looping over many URLs
    // with one `opts` object would naturally do.
    const sharedPattern = /R\$\s?[1-9]\d*[.,]\d{2}/g;

    const first = await extract(URL, { requireContent: { pattern: sharedPattern } });
    const second = await extract(URL, { requireContent: { pattern: sharedPattern } });

    expect(first.source).toBe("cheerio");
    expect(second.source).toBe("cheerio"); // would incorrectly escalate/fail if lastIndex leaked
  });

  it("requireContent.selector is passed to playwrightFetch as waitForSelector when the caller didn't set one explicitly", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200, contentType: "text/html" });
    (playwrightFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: REAL_PRICE_HTML, statusCode: 200 });

    await extract(URL, { requireContent: { selector: ".product-price" } });

    expect(playwrightFetch).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ waitForSelector: ".product-price" }),
    );
  });

  it("requireContent.selector does NOT override an explicit waitForSelector", async () => {
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: THIN_PRICE_HTML, statusCode: 200, contentType: "text/html" });
    (playwrightFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: REAL_PRICE_HTML, statusCode: 200 });

    await extract(URL, { waitForSelector: "#other", requireContent: { selector: ".product-price" } });

    expect(playwrightFetch).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ waitForSelector: "#other" }),
    );
  });

  it("the PDF path also honors requireContent — falls through to standard extraction if the PDF text doesn't match", async () => {
    (isPdfUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    (fetchPdfAsMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      markdown: "This PDF has no pricing information at all.",
      title: "Some PDF",
      pageCount: 1,
    });
    (cheerioFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ html: REAL_PRICE_HTML, statusCode: 200, contentType: "text/html" });

    const result = await extract(URL, { requireContent: { pattern: /R\$\s?[1-9]\d*[.,]\d{2}/ } });

    expect(fetchPdfAsMarkdown).toHaveBeenCalledOnce();
    expect(result.source).toBe("cheerio"); // fell through past the PDF path instead of accepting it
  });

  it("the PDF path returns immediately when requireContent IS satisfied by the extracted text", async () => {
    (isPdfUrl as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    (fetchPdfAsMarkdown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      markdown: "Total price: R$ 39,99",
      title: "Invoice",
      pageCount: 1,
    });

    const result = await extract(URL, { requireContent: { pattern: /R\$\s?[1-9]\d*[.,]\d{2}/ } });

    expect(result.source).toBe("pdf");
    expect(cheerioFetch).not.toHaveBeenCalled();
  });
});
