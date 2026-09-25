import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildAdLibraryUrl,
  adLibraryAdUrl,
  computeAdLibraryCredits,
  normalizeAd,
  parseAdLibraryGraphql,
  parseAdLibraryHtml,
  mergeParsed,
  detectAdLibraryBlock,
} from "./ad-library.js";

// Fixtures: sanitized slices (public commercial ads only, no media URLs) of real
// responses captured live on 2026-09-24 (query "example-brand", country BR).
const fx = (name: string) => readFileSync(join(__dirname, "__fixtures__", "ad-library", name), "utf8");

describe("buildAdLibraryUrl / adLibraryAdUrl", () => {
  it("builds the keyword search URL", () => {
    const u = new URL(buildAdLibraryUrl("example-brand product", "br", "active"));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/ads/library/");
    expect(u.searchParams.get("q")).toBe("example-brand product");
    expect(u.searchParams.get("country")).toBe("BR");
    expect(u.searchParams.get("active_status")).toBe("active");
    expect(u.searchParams.get("search_type")).toBe("keyword_unordered");
  });
  it("builds the canonical ad URL", () => {
    expect(adLibraryAdUrl("123456789")).toBe("https://www.facebook.com/ads/library/?id=123456789");
  });
});

describe("computeAdLibraryCredits", () => {
  it("mirrors instagram: ceil(max/10), min 1", () => {
    expect(computeAdLibraryCredits(1)).toBe(1);
    expect(computeAdLibraryCredits(50)).toBe(5);
    expect(computeAdLibraryCredits(200)).toBe(20);
  });
});

describe("parseAdLibraryGraphql (real fixture)", () => {
  const p = parseAdLibraryGraphql(fx("graphql-page.json"));
  it("extracts all ads with canonical fields", () => {
    expect(p.ads.map((a) => a.ad_archive_id)).toEqual(["746895045184628", "1566119418497585", "1792351488466362"]);
    const a = p.ads[0];
    expect(a.page_name).toBe("Retail Location One");
    expect(a.page_id).toBe("1225384017331678");
    expect(a.page_url).toBe("https://www.facebook.com/1225384017331678/");
    expect(a.ad_library_url).toBe("https://www.facebook.com/ads/library/?id=746895045184628");
    expect(a.body_text).toContain("autocuidado");
    expect(a.is_active).toBe(true);
    expect(a.start_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(a.publisher_platforms).toContain("INSTAGRAM");
  });
  it("keeps ads with no body text (dynamic product ads) as null body", () => {
    expect(p.ads[2].body_text).toBeNull();
  });
  it("reports pagination state and recognizes the structure", () => {
    expect(p.has_next_page).toBe(true);
    expect(p.connection_seen).toBe(true);
    expect(p.skipped_malformed).toBe(0);
  });
});

describe("parseAdLibraryHtml (real fixture)", () => {
  const p = parseAdLibraryHtml(fx("embedded-document.html"));
  it("extracts ads and total_found from the embedded JSON, ignoring other scripts", () => {
    expect(p.ads.length).toBe(3);
    expect(p.total_found).toBe(1086);
    expect(p.ads[0].ad_archive_id).toBe("1454114562663437");
    expect(p.ads[0].page_name).toBe("Example Brand");
  });
});

describe("robustness", () => {
  it("never throws on garbage and returns nothing", () => {
    for (const t of ["", "not json", "{", "null", "[]", "for (;;);{bad", "<html></html>"]) {
      expect(() => parseAdLibraryGraphql(t)).not.toThrow();
      expect(parseAdLibraryGraphql(t).ads).toEqual([]);
      expect(() => parseAdLibraryHtml(t)).not.toThrow();
    }
  });
  it("skips and counts malformed items without dropping good ones", () => {
    const good = JSON.parse(fx("graphql-page.json"));
    const bad = { ad_archive_id: "abc", snapshot: {} };
    const weird = { ad_archive_id: "9999999999", snapshot: "oops", page_id: 5, start_date: "x", publisher_platform: "nope" };
    good.data.ad_library_main.search_results_connection.edges.push({ node: { collated_results: [bad, weird, null] } });
    const p = parseAdLibraryGraphql(JSON.stringify(good));
    expect(p.ads.length).toBe(4); // 3 good + weird (id valid, other fields degrade to null)
    expect(p.skipped_malformed).toBe(1);
    const w = p.ads[3];
    expect(w.page_id).toBeNull();
    expect(w.start_date).toBeNull();
    expect(w.publisher_platforms).toEqual([]);
  });
  it("tolerates wrapper changes (finds ads structurally) and the for(;;); prefix", () => {
    const inner = JSON.parse(fx("graphql-page.json"));
    const p = parseAdLibraryGraphql("for (;;);" + JSON.stringify({ some: { new: { wrapper: inner } } }));
    expect(p.ads.length).toBe(3);
  });
  it("parses NDJSON responses line by line", () => {
    const one = JSON.stringify(JSON.parse(fx("graphql-page.json")));
    expect(parseAdLibraryGraphql(`${one}\n${one}`).ads.length).toBe(6);
  });
  it("detects an empty result connection (count 0) as recognized structure", () => {
    const p = parseAdLibraryGraphql(JSON.stringify({ data: { ad_library_main: { search_results_connection: { count: 0, edges: [] } } } }));
    expect(p.connection_seen).toBe(true);
    expect(p.total_found).toBe(0);
    expect(p.ads).toEqual([]);
  });
  it("normalizeAd rejects non-ads", () => {
    expect(normalizeAd(null)).toBeNull();
    expect(normalizeAd({})).toBeNull();
    expect(normalizeAd({ ad_archive_id: "1" })).toBeNull();
  });
});

describe("mergeParsed", () => {
  it("dedups by ad_archive_id across sources, first wins", () => {
    const m = new Map();
    const a = parseAdLibraryGraphql(fx("graphql-page.json"));
    expect(mergeParsed(m, a)).toBe(3);
    expect(mergeParsed(m, a)).toBe(0);
    expect(m.size).toBe(3);
  });
});

describe("detectAdLibraryBlock", () => {
  it("flags login/checkpoint URLs and block text", () => {
    expect(detectAdLibraryBlock("https://www.facebook.com/login/?next=x", "", "")).toBe("login_or_checkpoint_redirect");
    expect(detectAdLibraryBlock("https://www.facebook.com/checkpoint/1/", "", "")).not.toBeNull();
    expect(detectAdLibraryBlock("https://www.facebook.com/ads/library/", "", "Você precisa entrar para continuar")).not.toBeNull();
  });
  it("passes a normal results page", () => {
    expect(detectAdLibraryBlock("https://www.facebook.com/ads/library/?q=x", "Biblioteca de Anúncios da Meta", "~1.100 resultados")).toBeNull();
  });
});
