import { describe, it, expect } from "vitest";
import { config } from "../src/config.js";

describe("config", () => {
  it("has required fields with defaults", () => {
    expect(config.REDIS_URL).toBeDefined();
    expect(config.GO_MD_SERVICE_URL).toBeDefined();
    expect(config.PYTHON_LLM_URL).toBeDefined();
    expect(config.MAX_CONCURRENT_PAGES).toBeGreaterThan(0);
    expect(config.MAX_CRAWL_DEPTH).toBeGreaterThan(0);
    expect(config.MAX_CRAWL_URLS).toBeGreaterThan(0);
    expect(config.DEFAULT_TIMEOUT).toBeGreaterThan(0);
  });

  it("HEALTH_PORT defaults to 3003", () => {
    expect(config.HEALTH_PORT).toBe(3003);
  });

  it("Abrasio defaults to disabled", () => {
    expect(config.ABRASIO_API_URL).toBe("");
  });
});
