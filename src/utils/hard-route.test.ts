import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { HARD_ROUTE_DOMAINS: "shopee.com.br, shopee.com" },
}));

import { isHardRouteDomain } from "./hard-route.js";

describe("isHardRouteDomain", () => {
  it("matches a configured domain exactly", () => {
    expect(isHardRouteDomain("shopee.com.br")).toBe(true);
  });

  it("matches a subdomain of a configured domain", () => {
    expect(isHardRouteDomain("www.shopee.com.br")).toBe(true);
    expect(isHardRouteDomain("m.shopee.com")).toBe(true);
  });

  it("does not match an unrelated domain", () => {
    expect(isHardRouteDomain("example.com")).toBe(false);
  });

  it("does not false-positive on a domain that merely ends with the same letters", () => {
    // "notshopee.com.br" ends with "shopee.com.br" as a raw string but is a
    // different registrable domain — must require a "." boundary, not a bare suffix.
    expect(isHardRouteDomain("notshopee.com.br")).toBe(false);
  });

  it("handles null (unparseable URL) gracefully", () => {
    expect(isHardRouteDomain(null)).toBe(false);
  });
});
