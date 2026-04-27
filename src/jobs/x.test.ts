import { describe, it, expect } from "vitest";
import {
  isXLoginRedirect,
  buildXUrl,
  computeXCredits,
  parseXTimestamp,
} from "./x.js";

describe("isXLoginRedirect", () => {
  it("detects login flow redirect", () => {
    expect(isXLoginRedirect("https://x.com/i/flow/login")).toBe(true);
  });

  it("detects /login redirect", () => {
    expect(isXLoginRedirect("https://x.com/login")).toBe(true);
  });

  it("returns false for normal profile URL", () => {
    expect(isXLoginRedirect("https://x.com/nike")).toBe(false);
  });

  it("returns false for status URL", () => {
    expect(isXLoginRedirect("https://x.com/nike/status/123456789")).toBe(false);
  });
});

describe("buildXUrl", () => {
  it("builds profile URL", () => {
    expect(buildXUrl("profile", "nike")).toBe("https://x.com/nike");
  });

  it("builds search URL with encoded query", () => {
    expect(buildXUrl("search", "@nike")).toBe(
      "https://x.com/search?q=%40nike&src=typed_query&f=top"
    );
  });

  it("returns post URL unchanged when full URL", () => {
    const url = "https://x.com/nike/status/123456789";
    expect(buildXUrl("post", url)).toBe(url);
  });

  it("normalizes bare status ID to full URL", () => {
    expect(buildXUrl("post", "nike/status/123456789")).toBe(
      "https://x.com/nike/status/123456789"
    );
  });
});

describe("computeXCredits", () => {
  it("returns 1 for profile", () => {
    expect(computeXCredits("profile", 20)).toBe(1);
  });

  it("returns 1 for post", () => {
    expect(computeXCredits("post", 20)).toBe(1);
  });

  it("returns ceil(limit/10) for search", () => {
    expect(computeXCredits("search", 20)).toBe(2);
    expect(computeXCredits("search", 1)).toBe(1);
    expect(computeXCredits("search", 50)).toBe(5);
  });
});

describe("parseXTimestamp", () => {
  it("parses X date format to ISO string", () => {
    const result = parseXTimestamp("Wed Apr 20 14:00:00 +0000 2026");
    expect(result).toMatch(/^2026-04-20T/);
  });

  it("returns null for empty string", () => {
    expect(parseXTimestamp("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseXTimestamp(undefined)).toBeNull();
  });
});
