import { describe, it, expect } from "vitest";
import {
  parseCookieString,
  isInstagramLoginRedirect,
  buildInstagramUrl,
  computeInstagramCredits,
} from "./instagram.js";

describe("parseCookieString", () => {
  it("parses a single cookie", () => {
    const result = parseCookieString("sessionid=abc123", ".instagram.com");
    expect(result).toEqual([
      { name: "sessionid", value: "abc123", domain: ".instagram.com", path: "/" },
    ]);
  });

  it("parses multiple cookies separated by semicolons", () => {
    const result = parseCookieString("auth_token=tok; ct0=csrf", ".x.com");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: "auth_token", value: "tok" });
    expect(result[1]).toMatchObject({ name: "ct0", value: "csrf" });
  });

  it("ignores empty segments", () => {
    const result = parseCookieString("sessionid=abc;; other=val", ".instagram.com");
    expect(result).toHaveLength(2);
  });

  it("trims whitespace around name and value", () => {
    const result = parseCookieString(" sessionid = abc123 ", ".instagram.com");
    expect(result[0]).toMatchObject({ name: "sessionid", value: "abc123" });
  });
});

describe("isInstagramLoginRedirect", () => {
  it("detects /accounts/login/ redirect", () => {
    expect(isInstagramLoginRedirect("https://www.instagram.com/accounts/login/?next=/nike/")).toBe(true);
  });

  it("detects /challenge/ redirect", () => {
    expect(isInstagramLoginRedirect("https://www.instagram.com/challenge/")).toBe(true);
  });

  it("returns false for normal profile URL", () => {
    expect(isInstagramLoginRedirect("https://www.instagram.com/nike/")).toBe(false);
  });
});

describe("buildInstagramUrl", () => {
  it("builds profile URL", () => {
    expect(buildInstagramUrl("profile", "nike")).toBe("https://www.instagram.com/nike/");
  });

  it("builds hashtag URL", () => {
    expect(buildInstagramUrl("hashtag", "sneakers")).toBe(
      "https://www.instagram.com/explore/tags/sneakers/"
    );
  });

  it("builds search URL with encoded query", () => {
    expect(buildInstagramUrl("search", "nike shoes")).toBe(
      "https://www.instagram.com/explore/search/keyword/?q=nike%20shoes"
    );
  });

  it("returns post URL unchanged", () => {
    const url = "https://instagram.com/p/abc123/";
    expect(buildInstagramUrl("post", url)).toBe(url);
  });
});

describe("computeInstagramCredits", () => {
  it("returns 1 for profile", () => {
    expect(computeInstagramCredits("profile", 20)).toBe(1);
  });

  it("returns 1 for post", () => {
    expect(computeInstagramCredits("post", 20)).toBe(1);
  });

  it("returns ceil(limit/10) for hashtag", () => {
    expect(computeInstagramCredits("hashtag", 20)).toBe(2);
    expect(computeInstagramCredits("hashtag", 1)).toBe(1);
    expect(computeInstagramCredits("hashtag", 50)).toBe(5);
  });

  it("returns ceil(limit/10) for search", () => {
    expect(computeInstagramCredits("search", 15)).toBe(2);
  });
});
