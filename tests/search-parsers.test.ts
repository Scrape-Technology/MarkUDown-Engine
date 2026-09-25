import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseGoogleSerp,
  parseGoogleResults,
  classifyGoogleHref,
  citeToUrl,
  resolveGotoLinks,
  classifyGoogleHtml,
  classifyBingHtml,
  classifyDuckDuckGoHtml,
  type LocationFetcher,
} from "../src/jobs/search-parsers.js";

// REAL Google no-JS SERP (served via Abrasio on /httpservice/retry/enablejs),
// captured 2026-09-24 for `site:tiktok.com "example-brand"`, reduced to #rso.
const NOJS = readFileSync(new URL("./fixtures/google-nojs-serp.html", import.meta.url), "utf8");

// SYNTHETIC minimal JS-rendered markup (div.g > a > h3), kept for compatibility.
// Patchright is always soft-blocked by Google so no real capture was possible.
const JS_MARKUP = `
<div id="search"><div id="rso">
  <div class="g"><div><a href="https://www.tiktok.com/@example-brand_"><h3>example-brand (@example-brand_)</h3></a></div>
    <div class="VwiC3b">Perfil oficial da Example Brand</div></div>
  <div class="g"><a href="https://www.youtube.com/watch?v=abc"><h3>Video example-brand</h3></a>
    <div data-sncf="1">Resenha</div></div>
  <div class="g"><a href="https://www.tiktok.com/@example-brand_"><h3>Duplicado</h3></a></div>
  <div class="g"><a href="/search?q=related"><h3>Pesquisas relacionadas</h3></a></div>
</div></div>`;

const CLASSIC_MARKUP = `
<div id="main"><div class="g"><h3><a href="/url?q=https://www.pinterest.com/pin/123/&amp;sa=U&amp;ved=xyz">Pin example-brand</a></h3>
<div class="st">Snippet clássico</div></div>
<div class="g"><h3><a href="/url?q=https://www.google.com/maps&amp;sa=U">Maps</a></h3></div></div>`;

describe("parseGoogleSerp - real no-JS fixture", () => {
  const raw = parseGoogleSerp(NOJS, 20);

  it("extracts the 10 organic results with titles", () => {
    expect(raw).toHaveLength(10);
    expect(raw[0].title).toBe("example-brand");
    expect(raw[1].title).toBe("example-brand (@example-brand_)");
    expect(raw.every((r) => r.title.length > 0)).toBe(true);
  });

  it("keeps opaque relative /goto links pending instead of dropping them", () => {
    expect(raw.every((r) => r.url === "" && r.gotoPath?.startsWith("/goto?url="))).toBe(true);
    expect(new Set(raw.map((r) => r.gotoPath)).size).toBe(10);
  });

  it("extracts snippets for standard results and leaves carousel entries blank", () => {
    expect(raw[1].snippet).toContain("Perfil oficial");
    expect(raw[2].title).toContain("Perfumes Example Brand");
    expect(raw[2].snippet).toBe("");
  });

  it("rebuilds a breadcrumb URL fallback from <cite>", () => {
    expect(raw[0].citeUrl).toBe("https://www.tiktok.com/tag/example-brand");
  });

  it("ignores internal Google links (/search?, /preferences, enablejs)", () => {
    const hrefs = raw.map((r) => r.gotoPath!);
    expect(hrefs.some((h) => h.includes("/search") || h.includes("/preferences"))).toBe(false);
  });

  it("respects the limit", () => {
    expect(parseGoogleSerp(NOJS, 3)).toHaveLength(3);
  });

  it("sync parseGoogleResults skips still-opaque results (no relative URLs leak)", () => {
    expect(parseGoogleResults(NOJS, 10)).toEqual([]);
  });
});

describe("parseGoogleResults - other markups", () => {
  it("JS div.g markup: absolute URLs, snippet, dedupe, internal links skipped", () => {
    const r = parseGoogleResults(JS_MARKUP, 10);
    expect(r.map((x) => x.url)).toEqual(["https://www.tiktok.com/@example-brand_", "https://www.youtube.com/watch?v=abc"]);
    expect(r[0].title).toBe("example-brand (@example-brand_)");
    expect(r[0].snippet).toBe("Perfil oficial da Example Brand");
    expect(r[1].snippet).toBe("Resenha");
  });

  it("classic /url?q= markup: real URL taken from q, google.com targets ignored", () => {
    const r = parseGoogleResults(CLASSIC_MARKUP, 10);
    expect(r).toHaveLength(1);
    expect(r[0].url).toBe("https://www.pinterest.com/pin/123/");
    expect(r[0].title).toBe("Pin example-brand");
  });

  it("skips ads (#tads)", () => {
    const html = `<div id="tads"><a href="https://ad.example.com/"><h3>Ad</h3></a></div>
      <div id="rso"><div class="g"><a href="https://real.example.com/"><h3>Real</h3></a></div></div>`;
    expect(parseGoogleResults(html, 10).map((x) => x.url)).toEqual(["https://real.example.com/"]);
  });
});

describe("classifyGoogleHref", () => {
  it.each(["/search?q=x", "/preferences?hl=pt", "#", "javascript:void(0)", "https://accounts.google.com/x", "/travel/flights", ""])(
    "rejects %s",
    (h) => expect(classifyGoogleHref(h)).toBeNull(),
  );
  it("passes absolute external URLs and decodes /url?q=", () => {
    expect(classifyGoogleHref("https://youtube.com/@a")).toEqual({ url: "https://youtube.com/@a" });
    expect(classifyGoogleHref("/url?q=https%3A%2F%2Fa.com%2Fx%3Fy%3D1&sa=U")).toEqual({ url: "https://a.com/x?y=1" });
    expect(classifyGoogleHref("/goto?url=CAES1")).toEqual({ gotoPath: "/goto?url=CAES1" });
  });
});

describe("citeToUrl", () => {
  it("joins breadcrumb parts", () => {
    expect(citeToUrl("https://www.tiktok.com › @example-brand_ › video › 123")).toBe(
      "https://www.tiktok.com/@example-brand_/video/123",
    );
    expect(citeToUrl("https://www.youtube.com")).toBe("https://www.youtube.com");
  });
  it("refuses truncated breadcrumbs", () => {
    expect(citeToUrl("https://www.tiktok.com › … › 123")).toBeUndefined();
  });
});

describe("resolveGotoLinks", () => {
  const raw = parseGoogleSerp(NOJS, 20);

  it("resolves via location header, dedupes final URLs, limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const fetcher: LocationFetcher = async (u) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      // every token maps to a unique URL, except the last two which collide
      const i = raw.findIndex((x) => u.endsWith(x.gotoPath!));
      return `https://www.tiktok.com/@u/video/${i >= 8 ? 8 : i}`;
    };
    const out = await resolveGotoLinks(raw, 10, { concurrency: 3, fetcher });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out.resolved).toBe(10);
    expect(out.results).toHaveLength(9);
    expect(out.results[0].url).toBe("https://www.tiktok.com/@u/video/0");
    expect(out.results.some((r) => r.url_approximate)).toBe(false);
  });

  it("falls back to breadcrumb URL (flagged) on failure and drops when none", async () => {
    const fetcher: LocationFetcher = async () => {
      throw new Error("timeout");
    };
    const out = await resolveGotoLinks(raw, 10, { fetcher });
    expect(out.resolved).toBe(0);
    expect(out.approximated).toBe(out.results.length);
    expect(out.results.every((r) => r.url_approximate && r.url.startsWith("https://"))).toBe(true);
    expect(out.results[0].url).toBe("https://www.tiktok.com/tag/example-brand");
    expect(out.dropped + out.results.length).toBe(10);
  });

  it("rejects Google-hosted or relative locations", async () => {
    const fetcher: LocationFetcher = async () => "/sorry/index";
    const out = await resolveGotoLinks(raw.slice(0, 1), 1, { fetcher });
    expect(out.resolved).toBe(0);
  });

  it("passes exact URLs through untouched", async () => {
    const out = await resolveGotoLinks([{ title: "t", snippet: "s", url: "https://a.com/" }], 5, {
      fetcher: async () => {
        throw new Error("must not be called");
      },
    });
    expect(out.results).toEqual([{ title: "t", url: "https://a.com/", snippet: "s" }]);
  });
});

describe("block / empty detection", () => {
  it("Google: captcha vs no results vs unparsed vs ok", () => {
    expect(classifyGoogleHtml("<form id=\"captcha-form\"></form>", 0).status).toBe("blocked");
    expect(classifyGoogleHtml("Nossos sistemas detectaram tráfego incomum", 0).status).toBe("blocked");
    expect(classifyGoogleHtml("<p>Sua pesquisa não encontrou nenhum documento correspondente.</p>", 0).status).toBe(
      "no_results",
    );
    expect(classifyGoogleHtml("<html><body>???</body></html>", 0).status).toBe("unparsed");
    expect(classifyGoogleHtml("anything", 3).status).toBe("ok");
    // the real no-JS fixture contains no captcha marker
    expect(classifyGoogleHtml(NOJS, 0).status).toBe("unparsed");
  });

  it("Bing: .b_no is not a success", () => {
    expect(classifyBingHtml('<ol><li class="b_no">Não há resultados para</li></ol>', 0).status).toBe("no_results");
    expect(classifyBingHtml("<html></html>", 0).status).toBe("unparsed");
    expect(classifyBingHtml("x", 2).status).toBe("ok");
  });

  it("DuckDuckGo: 202 / anomaly modal is a challenge", () => {
    expect(classifyDuckDuckGoHtml("<html></html>", 0, 202).status).toBe("blocked");
    expect(classifyDuckDuckGoHtml('<div class="anomaly-modal"></div>', 0, 200).status).toBe("blocked");
    expect(classifyDuckDuckGoHtml("<html></html>", 0, 200).status).toBe("unparsed");
  });
});
