import { describe, it, expect } from "vitest";
import {
  vtexSearchUrl,
  parseVtexSearch,
  parseKwaiLdJson,
  kwaiDiscoverUrl,
  parseTikTokEmbed,
  parseFacebookPage,
  normalizeForMatch,
} from "../src/jobs/search-parsers.js";
import {
  facebookPageUrl,
  onDomain,
  enrichResults,
  safeErrorDetail,
  RetryableReadError,
  type Enricher_,
} from "../src/jobs/search.js";
import { ContentValidationError } from "../src/engine/cheerio-engine.js";

// SYNTHETIC data. Only the JSON/markup SHAPE follows the platforms (checked live 2026-10-06);
// every id, handle, name, price and URL below is made up.

const ORIGIN = "https://shop.example.com.br";

const seller = (name: string, id: string, price: number, qty: number) => ({
  sellerId: id,
  sellerName: name,
  sellerDefault: false,
  commertialOffer: { Price: price, AvailableQuantity: qty },
});

describe("VTEX catalog search (americanas engine)", () => {
  it("builds the in-stock full-text catalog URL, capped at 50", () => {
    expect(vtexSearchUrl(ORIGIN, "example brand", 20)).toBe(
      `${ORIGIN}/api/catalog_system/pub/products/search?ft=example%20brand&fq=isAvailablePerSalesChannel_1:1&_from=0&_to=19`,
    );
    expect(vtexSearchUrl(ORIGIN, "x", 500)).toContain("&_to=49");
  });

  it("takes the cheapest in-stock offer, lists every 3P seller, drops the brand placeholder", () => {
    const body = JSON.stringify([
      {
        productName: "Example-brand Body Splash 200ml",
        brand: "Não Disponível",
        link: `${ORIGIN}/example-brand-body-splash-1000000000000000001/p`,
        items: [
          { sellers: [seller("STORE SA", "1", 0, 0), seller("Loja Exemplo", "SELLER0001", 59.9, 3)] },
          { sellers: [seller("Outra Loja", "SELLER0002", 49.9, 1), seller("Loja Exemplo", "SELLER0001", 79.9, 1)] },
        ],
      },
      { productName: "Without stock", brand: "Example", link: "/without-stock/p", items: [{ sellers: [seller("STORE SA", "1", 0, 0)] }] },
      { productName: "", link: "/broken/p", items: [] },
    ]);
    const r = parseVtexSearch(body, ORIGIN, 10);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      title: "Example-brand Body Splash 200ml",
      url: `${ORIGIN}/example-brand-body-splash-1000000000000000001/p`,
      snippet: "R$ 49.90 · vendido por Outra Loja",
      details: {
        price: 49.9,
        currency: "BRL",
        seller: "Outra Loja",
        seller_id: "SELLER0002",
        offers: [
          { seller: "Outra Loja", seller_id: "SELLER0002", price: 49.9 },
          { seller: "Loja Exemplo", seller_id: "SELLER0001", price: 59.9 },
        ],
        available: true,
      },
    });
    // relative link absolutized; no stock => no price/seller, available false
    expect(r[1]).toEqual({
      title: "Without stock",
      url: `${ORIGIN}/without-stock/p`,
      snippet: "sem estoque · marca Example",
      details: { brand: "Example", available: false },
    });
  });

  it("also reads the Intelligent Search shape ({products}) and garbage safely", () => {
    const body = JSON.stringify({ products: [{ productName: "A", link: "/a/p", items: [{ sellers: [seller("S", "1", 10, 1)] }] }] });
    expect(parseVtexSearch(body, ORIGIN, 5)[0].details?.seller).toBe("S");
    expect(parseVtexSearch("<html>blocked</html>", ORIGIN, 5)).toEqual([]);
    expect(parseVtexSearch("[]", ORIGIN, 5)).toEqual([]);
  });
});

const kwaiVideo = (id: string, handle: string, caption: string) => ({
  url: `https://www.kwai.com/@${handle}/video/${id}`,
  name: `${handle} (${handle}). Áudio original. ${caption}`,
  description: caption,
  transcript: "fala do video",
  uploadDate: "2026-01-02T03:04:05Z",
  creator: { mainEntity: { name: `Nome ${handle}`, alternateName: handle, url: `https://www.kwai.com/@${handle}` } },
  "@type": "VideoObject",
});

describe("Kwai SEO ld+json", () => {
  it("discover page: ItemList -> videos with creator; innerHTML as object or string", () => {
    const body = JSON.stringify({
      status: 200,
      data: [
        { id: "BreadcrumbList", innerHTML: { "@type": "BreadcrumbList", itemListElement: [{ position: 1, item: "https://www.kwai.com" }] } },
        {
          id: "ItemList",
          innerHTML: JSON.stringify({
            "@type": "ItemList",
            itemListElement: [kwaiVideo("1000000000000000001", "someone", "#examplebrand haul"), kwaiVideo("1000000000000000002", "other", "x")],
          }),
        },
      ],
    });
    const r = parseKwaiLdJson(body, 10);
    expect(r.map((x) => x.url)).toEqual([
      "https://www.kwai.com/@someone/video/1000000000000000001",
      "https://www.kwai.com/@other/video/1000000000000000002",
    ]);
    expect(r[0].details).toEqual({
      author: "Nome someone",
      author_handle: "someone",
      author_url: "https://www.kwai.com/@someone",
      text: "#examplebrand haul · fala do video",
      published_at: "2026-01-02T03:04:05Z",
    });
    expect(parseKwaiLdJson(body, 1)).toHaveLength(1);
  });

  it("video page: a single VideoObject", () => {
    const body = JSON.stringify({ status: 200, data: [{ id: "VideoObject", innerHTML: kwaiVideo("1000000000000000003", "someone", "c") }] });
    expect(parseKwaiLdJson(body, 1)[0].details?.author_handle).toBe("someone");
    expect(parseKwaiLdJson("not json", 5)).toEqual([]);
  });

  it("discover URL uses the site's slug form; matching ignores case/accents/spacing", () => {
    expect(kwaiDiscoverUrl(" Example Brand ")).toBe("https://www.kwai.com/discover/example-brand");
    expect(normalizeForMatch("Body-Splash Ação")).toBe("bodysplashacao");
    expect(normalizeForMatch("#bodysplash viral")).toContain(normalizeForMatch("body splash"));
  });
});

const tiktokEmbed = (data: unknown) =>
  `<html><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify({ source: { data } })}</script></html>`;

describe("TikTok embed page", () => {
  it("reads video, author and stats", () => {
    const html = tiktokEmbed({
      "/embed/v2/1000000000000000001": {
        videoData: {
          itemInfos: {
            id: "1000000000000000001",
            text: " example-brand review #fyp ",
            createTime: "1767225600",
            playCount: 1200,
            diggCount: 34,
            commentCount: 5,
            shareCount: 2,
            isAd: false,
            isECVideo: 1,
          },
          authorInfos: { uniqueId: "someone", nickName: "Some One" },
          authorStats: { followerCount: 4321 },
        },
      },
      strategy: {},
    });
    expect(parseTikTokEmbed(html)).toEqual({
      author: "Some One",
      author_handle: "someone",
      author_url: "https://www.tiktok.com/@someone",
      followers: 4321,
      text: "example-brand review #fyp",
      published_at: "2026-01-01T00:00:00.000Z",
      is_ad: false,
      is_shop_video: true,
      stats: { plays: 1200, likes: 34, comments: 5, shares: 2 },
    });
  });

  it("removed video => available:false; WAF page / 503 body => undefined", () => {
    expect(parseTikTokEmbed(tiktokEmbed({ "/embed/v2/1": { isError: true, errorCode: 10204, errorStatus: 400 } }))).toEqual({ available: false });
    expect(parseTikTokEmbed("overload-protect triggered")).toBeUndefined();
    expect(parseTikTokEmbed("<html><title>Security Check</title></html>")).toBeUndefined();
  });
});

describe("Facebook page (logged out)", () => {
  const page =
    '<html><head><meta property="og:title" content="Example &amp; Brand Store" /></head><body><script>' +
    '{"profile_social_context":{"content":[{"text":{"delight_ranges":[],"inline_style_ranges":[{"length":5,"offset":0}],' +
    '"text":"12\\u00a0mil seguidores"},"uri":"x"}]},"delegate_page":{"id":"1000000000000000001","category_name":"Cosmetics store"},' +
    '"renderer":{"__typename":"WebsiteContextItemRenderer","context_item":{"plaintext_title":{"delight_ranges":[],"text":"example.com\\/loja"}}}}' +
    "</script></body></html>";

  it("reads name, followers, category and external website", () => {
    expect(parseFacebookPage(page)).toEqual({
      author: "Example & Brand Store",
      followers: "12 mil seguidores",
      category: "Cosmetics store",
      website: "example.com/loja",
    });
  });

  it("login wall / no og:title => undefined", () => {
    expect(parseFacebookPage('<meta property="og:title" content="Facebook" />')).toBeUndefined();
    expect(parseFacebookPage("<html></html>")).toBeUndefined();
  });

  it("maps posts/videos to their page; profile.php keeps the id; reserved paths are not pages", () => {
    expect(facebookPageUrl("https://www.facebook.com/example.brand/videos/some-title/1000000000000000001/")).toBe(
      "https://www.facebook.com/example.brand",
    );
    expect(facebookPageUrl("https://m.facebook.com/profile.php?id=1000000000000000001&sk=about")).toBe(
      "https://www.facebook.com/profile.php?id=1000000000000000001",
    );
    for (const u of [
      "https://www.facebook.com/groups/1000000000000000001/",
      "https://www.facebook.com/marketplace/item/1000000000000000001/",
      "https://www.facebook.com/watch/?v=1000000000000000001",
      "https://www.facebook.com/permalink.php?story_fbid=1",
      "https://www.example.com/example.brand",
    ]) {
      expect(facebookPageUrl(u), u).toBeUndefined();
    }
  });
});

describe("platform engines keep only the platform's own URLs", () => {
  const r = (url: string) => ({ title: "t", url, snippet: "" });
  it("filters by host (subdomains yes, look-alikes no)", () => {
    const o = onDomain("tiktok.com", {
      status: "ok",
      results: [r("https://www.tiktok.com/@someone/video/1000000000000000001"), r("https://nottiktok.com/x"), r("https://tiktok.com.example.io/x"), r("bad url")],
    });
    expect(o.results.map((x) => x.url)).toEqual(["https://www.tiktok.com/@someone/video/1000000000000000001"]);
    expect(o.status).toBe("ok");
  });
  it("an engine that answered only off-platform URLs found nothing (the auto chain goes on)", () => {
    const o = onDomain("facebook.com", { status: "ok", results: [r("https://www.example.com/body")] });
    expect(o).toEqual({ results: [], status: "no_results", detail: "1 results, none on facebook.com" });
    expect(onDomain("facebook.com", { status: "blocked", results: [] }).status).toBe("blocked");
  });
});

const res = (url: string) => ({ title: "t", url, snippet: "" });
const fbUrl = (n: number) => `https://www.facebook.com/example.page${n}/videos/x/1000000000000000001/`;

function fakeEnricher(read: (key: string) => Promise<unknown>): Enricher_ & { calls: number } {
  const e = {
    calls: 0,
    match: (url: string) => (url.includes("facebook.com") ? url : undefined),
    read: async (key: string) => {
      e.calls++;
      return (await read(key)) as never;
    },
  };
  return e;
}
const noSlot = async () => async () => {};

describe("enrichResults retry policy and budget (M8-1, M8-2)", () => {
  it("a page that was read but has no data ends on the first attempt (no retry)", async () => {
    const e = fakeEnricher(async () => undefined);
    const rs = [res(fbUrl(1)), res(fbUrl(2))];
    expect(await enrichResults(rs, 30_000, { enrichers: [e], acquire: noSlot, pauseMs: 0 })).toBe(0);
    expect(e.calls).toBe(2); // 2 distinct pages x 1 attempt
  });

  it("retries transport errors / 429 / 503 until it reads, then stops", async () => {
    let n = 0;
    const e = fakeEnricher(async () => {
      if (++n === 1) throw new RetryableReadError(503);
      if (n === 2) throw new Error("socket hang up");
      return { author: "Example" };
    });
    const rs = [res(fbUrl(1))];
    expect(await enrichResults(rs, 30_000, { enrichers: [e], acquire: noSlot, pauseMs: 0 })).toBe(1);
    expect(e.calls).toBe(3);
    expect(rs[0].details).toEqual({ author: "Example" });
  });

  it("gives up after 5 attempts and never throws", async () => {
    const e = fakeEnricher(async () => {
      throw new RetryableReadError(429);
    });
    expect(await enrichResults([res(fbUrl(1))], 30_000, { enrichers: [e], acquire: noSlot, pauseMs: 0 })).toBe(0);
    expect(e.calls).toBe(5);
  });

  it("does not start reads or retries after the deadline", async () => {
    const e = fakeEnricher(async () => {
      throw new RetryableReadError(503);
    });
    const rs = [1, 2, 3, 4, 5, 6].map((n) => res(fbUrl(n)));
    await enrichResults(rs, 30_000, { enrichers: [e], acquire: noSlot, pauseMs: 0, deadline: Date.now() - 1 });
    expect(e.calls).toBe(0);
  });

  it("takes a slot of the platform's domain for every read and always releases it", async () => {
    const log: string[] = [];
    const acquire = async (d: string) => {
      log.push(`acquire ${d}`);
      return async () => {
        log.push(`release ${d}`);
      };
    };
    let n = 0;
    const e = fakeEnricher(async () => {
      if (++n === 1) throw new Error("boom");
      return { author: "x" };
    });
    await enrichResults([res(fbUrl(1))], 30_000, { enrichers: [e], acquire, pauseMs: 0 });
    expect(log).toEqual(["acquire www.facebook.com", "release www.facebook.com", "acquire www.facebook.com", "release www.facebook.com"]);
  });

  it("default budget is 40% of the job timeout", async () => {
    const e = fakeEnricher(async () => undefined);
    const t0 = Date.now();
    await enrichResults([res(fbUrl(1))], 10, { enrichers: [e], acquire: noSlot, pauseMs: 0 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("hardening of the new parsers (M8-3 and low items)", () => {
  it("parseTikTokEmbed is linear on a hostile body (repeated <script )", () => {
    const t0 = Date.now();
    expect(parseTikTokEmbed("<script ".repeat(100_000))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("parseFacebookPage is fast on hostile input", () => {
    const t0 = Date.now();
    expect(parseFacebookPage('<meta property="og:title" '.repeat(20_000))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("VTEX: a bad / foreign / non-https link drops only its own item", () => {
    const item = (link: string) => ({ productName: "P", link, items: [{ sellers: [seller("S", "1", 10, 1)] }] });
    const body = JSON.stringify([
      item("javascript:alert(1)"),
      item("https://evil.example.org/p"),
      item("http://shop.example.com.br/insecure/p"),
      item("http://[bad"),
      item("/ok/p"),
      { productName: "x".repeat(2000), link: "/long/p", items: [] },
    ]);
    const r = parseVtexSearch(body, ORIGIN, 10);
    expect(r.map((x) => x.url)).toEqual([`${ORIGIN}/ok/p`, `${ORIGIN}/long/p`]);
    expect(r[1].title).toHaveLength(500);
  });

  it("TikTok: an absurd createTime does not throw and just omits the date", () => {
    const html = tiktokEmbed({
      "/embed/v2/1": { videoData: { itemInfos: { text: "t".repeat(2000), createTime: "99999999999999999", playCount: 1 }, authorInfos: { uniqueId: "someone" } } },
    });
    const d = parseTikTokEmbed(html)!;
    expect(d.published_at).toBeUndefined();
    expect(d.author_handle).toBe("someone");
    expect(d.text).toHaveLength(500);
  });

  it("error text that reaches engines[x].detail has no URL or proxy text", () => {
    const leaky = Object.assign(new Error("Stealth request failed for https://www.tiktok.com/embed/v2/1?token=abc via http://user:pass@proxy.example:9000"), {
      name: "HTTPError",
      statusCode: 502,
    });
    expect(safeErrorDetail(leaky)).toBe("HTTPError HTTP 502");
    expect(safeErrorDetail(new Error("http://user:pass@proxy.example:9000 refused"))).toBe("Error");
    expect(safeErrorDetail(new ContentValidationError("HTTP 403"))).toBe("HTTP 403");
    expect(safeErrorDetail(new RetryableReadError(503))).toBe("HTTP 503");
  });
});
