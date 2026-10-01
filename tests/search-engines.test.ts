import { describe, it, expect } from "vitest";
import {
  decodeDuckDuckGoHref,
  parseDuckDuckGoResults,
  parseBraveResults,
  classifyBraveHtml,
  parseYouTubeResults,
  extractYtInitialData,
  parsePinterestSearch,
  pinterestSearchUrl,
} from "../src/jobs/search-parsers.js";

// SYNTHETIC data. Only the markup/JSON SHAPE follows the engines' pages (checked 2026-09-30);
// every id, handle, title and URL below is made up.

const DDG = `
<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.kwai.com%2F%40someone%2Fvideo%2F1000000000000000001&amp;rut=abc">example-brand haul</a></h2>
  <a class="result__snippet" href="#">Resenha example-brand</a></div></div>
<div class="result result--ad"><div class="result__body"><a class="result__a" href="//duckduckgo.com/y.js?ad=1">Ad</a></div></div>`;

describe("DuckDuckGo html endpoint", () => {
  it("decodes the uddg redirect wrapper (old parser dropped every result)", () => {
    expect(decodeDuckDuckGoHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fx&rut=1")).toBe("https://a.com/x");
    expect(decodeDuckDuckGoHref("https://b.com/y")).toBe("https://b.com/y");
    expect(decodeDuckDuckGoHref("//duckduckgo.com/y.js?ad=1")).toBeUndefined();
  });
  it("parses organic results and skips ads", () => {
    const r = parseDuckDuckGoResults(DDG, 10);
    expect(r).toEqual([
      { title: "example-brand haul", url: "https://www.kwai.com/@someone/video/1000000000000000001", snippet: "Resenha example-brand" },
    ]);
  });
});

const BRAVE = `<main><div id="results">
<div class="snippet svelte-jmfu5f" data-pos="0" data-type="web"><div class="result-content">
  <a href="https://www.kwai.com/discover/example-brand-logo?lang=pt-BR" class="l1"><div class="site-name-content"><cite class="snippet-url">kwai.com</cite></div>
  <div class="title search-snippet-title">example-brand logo | Discover</div></a>
  <div class="generic-snippet"><div class="content">Jan 1, 2024 - snippet about example-brand</div></div></div></div>
<div class="snippet" data-type="web"><a href="https://www.kwai.com/discover/example-brand-logo?lang=pt-BR"><div class="title">dup</div></a></div>
<div class="snippet" data-type="news"><a href="https://news.example/x"><div class="title">news</div></a></div>
</div></main>`;

describe("Brave Search", () => {
  it("parses web snippets, dedupes, ignores other modules", () => {
    const r = parseBraveResults(BRAVE, 10);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      url: "https://www.kwai.com/discover/example-brand-logo?lang=pt-BR",
      title: "example-brand logo | Discover",
      snippet: "Jan 1, 2024 - snippet about example-brand",
    });
  });
  it("classifies captcha vs empty", () => {
    expect(classifyBraveHtml(`<title>Captcha - Brave Search</title><form action="/search/captcha"></form>`, 0).status).toBe("blocked");
    expect(classifyBraveHtml(`<main><div>Not many great matches came back for your search</div></main>`, 0).status).toBe("no_results");
    expect(classifyBraveHtml(BRAVE, 1).status).toBe("ok");
  });
});

const YT_DATA = {
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
    { videoRenderer: { videoId: "AAAAAAAAAAA", title: { runs: [{ text: "EXAMPLE-BRAND REVIEW" }] },
      ownerText: { runs: [{ text: "Some Creator", navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: "/@somecreator" } } }] },
      detailedMetadataSnippets: [{ snippetText: { runs: [{ text: "is it " }, { text: "worth it" }] } }] } },
    { channelRenderer: { channelId: "UCxxxxxxxxxxxxxxxxxxxxxx", title: { simpleText: "Example Brand" },
      navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: "/@example_brand" } }, subscriberCountText: { simpleText: "@example_brand" } } },
    { videoRenderer: { videoId: "AAAAAAAAAAA", title: { runs: [{ text: "dup" }] } } },
  ] } }] } } } },
};
const YT_HTML = `<html><script nonce="x">var ytInitialData = ${JSON.stringify(YT_DATA)};</script></html>`;

describe("YouTube native search (ytInitialData)", () => {
  it("extracts videos and channels", () => {
    const r = parseYouTubeResults(YT_HTML, 10);
    expect(r).toEqual([
      { title: "EXAMPLE-BRAND REVIEW", url: "https://www.youtube.com/watch?v=AAAAAAAAAAA", snippet: "Some Creator · https://www.youtube.com/@somecreator · is it worth it" },
      { title: "Example Brand", url: "https://www.youtube.com/@example_brand", snippet: "@example_brand" },
    ]);
  });
  it("returns nothing (and no blob) on a consent/blocked shell", () => {
    expect(extractYtInitialData("<html>consent</html>")).toBeUndefined();
    expect(parseYouTubeResults("<html>consent</html>", 10)).toEqual([]);
  });
});

const PIN_JSON = JSON.stringify({ resource_response: { data: { results: [
  { type: "story", id: "c6SZT6Bw", title: { format: "x" } },
  { type: "pin", id: "1000000000000000002", grid_title: "Pin title example-brand", description: "example-brand hair", pinner: { username: "someone" }, link: "https://shop.example/x?a=1&b=2" },
  { type: "pin", id: "1000000000000000003", grid_title: "", description: " " },
] } } });

describe("Pinterest native search (BaseSearchResource)", () => {
  it("parses pins from raw JSON and skips story modules", () => {
    const r = parsePinterestSearch(PIN_JSON, 10);
    expect(r).toEqual([
      { title: "Pin title example-brand", url: "https://www.pinterest.com/pin/1000000000000000002/", snippet: "example-brand hair · @someone · https://shop.example/x?a=1&b=2" },
      { title: "Pin 1000000000000000003", url: "https://www.pinterest.com/pin/1000000000000000003/", snippet: "" },
    ]);
  });
  it("parses the HTML-escaped JSON a browser layer wraps in <pre>", () => {
    const wrapped = `<html><body><pre>${PIN_JSON.replace(/&/g, "&amp;")}</pre></body></html>`;
    const r = parsePinterestSearch(wrapped, 10);
    expect(r).toHaveLength(2);
    expect(r[0].snippet).toContain("?a=1&b=2");
  });
  it("builds the resource URL", () => {
    const u = new URL(pinterestSearchUrl("example brand"));
    expect(u.pathname).toBe("/resource/BaseSearchResource/get/");
    expect(JSON.parse(u.searchParams.get("data")!).options).toMatchObject({ query: "example brand", scope: "pins" });
    expect(u.searchParams.get("source_url")).toBe("/search/pins/?q=example%20brand");
  });
});

describe("Bing /ck/a redirect links", () => {
  const real = "https://www.americanas.com.br/produto/123/example-brand";
  const ck = `https://www.bing.com/ck/a?!&&p=abc&ptn=3&ver=2&hsh=4&u=a1${Buffer.from(real).toString("base64url")}&ntb=1`;
  it("decodes the base64url target", async () => {
    const { decodeBingHref, parseBingResults } = await import("../src/jobs/search-parsers.js");
    expect(decodeBingHref(ck)).toBe(real);
    expect(decodeBingHref("https://direct.example/x")).toBe("https://direct.example/x");
    const html = `<ol id="b_results"><li class="b_algo"><h2><a href="${ck.replace(/&/g, "&amp;")}">T</a></h2><div class="b_caption"><p>S</p></div></li></ol>`;
    expect(parseBingResults(html, 5)).toEqual([{ title: "T", url: real, snippet: "S" }]);
  });
});
