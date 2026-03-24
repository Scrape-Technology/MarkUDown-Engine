import { describe, it, expect } from "vitest";
import { normalizeUrl, getRegisteredDomain, isSameDomain, filterUrl } from "../src/utils/url-utils.js";

describe("normalizeUrl", () => {
  it("removes trailing slash", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
  });

  it("removes fragment", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
  });

  it("preserves query params", () => {
    expect(normalizeUrl("https://example.com/page?q=test")).toBe("https://example.com/page?q=test");
  });

  it("returns original for invalid URLs", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("getRegisteredDomain", () => {
  it("extracts domain from subdomain", () => {
    expect(getRegisteredDomain("https://sub.example.com/path")).toBe("example.com");
  });

  it("returns hostname for top-level domain", () => {
    expect(getRegisteredDomain("https://example.com")).toBe("example.com");
  });

  it("handles deep subdomains", () => {
    expect(getRegisteredDomain("https://a.b.c.example.com")).toBe("example.com");
  });
});

describe("isSameDomain", () => {
  it("returns true for same host", () => {
    expect(isSameDomain("https://example.com/page", "https://example.com")).toBe(true);
  });

  it("returns true for subdomain of base", () => {
    expect(isSameDomain("https://blog.example.com", "https://example.com")).toBe(true);
  });

  it("returns false for different domain", () => {
    expect(isSameDomain("https://other.com", "https://example.com")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isSameDomain("invalid", "also-invalid")).toBe(false);
  });
});

describe("filterUrl", () => {
  it("blocks URLs with blocked words", () => {
    expect(filterUrl("https://example.com/blog/post", { blockedWords: ["blog"] })).toBe(false);
  });

  it("allows URLs without blocked words", () => {
    expect(filterUrl("https://example.com/product/1", { blockedWords: ["blog"] })).toBe(true);
  });

  it("requires allowed words when specified", () => {
    expect(filterUrl("https://example.com/product/1", { allowedWords: ["docs"] })).toBe(false);
    expect(filterUrl("https://example.com/docs/api", { allowedWords: ["docs"] })).toBe(true);
  });

  it("blocks URLs matching blocked patterns", () => {
    expect(filterUrl("https://example.com/admin/users", { blockedPatterns: ["/admin/"] })).toBe(false);
  });

  it("returns true with no filters", () => {
    expect(filterUrl("https://example.com/anything", {})).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(filterUrl("https://example.com/BLOG/post", { blockedWords: ["blog"] })).toBe(false);
  });
});
