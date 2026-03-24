import { describe, it, expect } from "vitest";
import {
  TransportableError,
  ScrapeTimeoutError,
  CaptchaDetectedError,
  BlockedError,
  AllLayersFailedError,
} from "../src/utils/errors.js";

describe("Error hierarchy", () => {
  it("TransportableError has statusCode", () => {
    const err = new TransportableError("test", 422);
    expect(err.message).toBe("test");
    expect(err.statusCode).toBe(422);
    expect(err).toBeInstanceOf(Error);
  });

  it("ScrapeTimeoutError has 504 status", () => {
    const err = new ScrapeTimeoutError("https://example.com", 30000);
    expect(err.statusCode).toBe(504);
    expect(err.name).toBe("ScrapeTimeoutError");
    expect(err.message).toContain("30000ms");
    expect(err).toBeInstanceOf(TransportableError);
  });

  it("CaptchaDetectedError has 403 status", () => {
    const err = new CaptchaDetectedError("https://example.com");
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain("CAPTCHA");
  });

  it("BlockedError preserves HTTP status", () => {
    const err = new BlockedError("https://example.com", 429);
    expect(err.statusCode).toBe(429);
  });

  it("AllLayersFailedError joins error messages", () => {
    const err = new AllLayersFailedError("https://example.com", ["Cheerio: timeout", "Playwright: blocked"]);
    expect(err.message).toContain("Cheerio: timeout");
    expect(err.message).toContain("Playwright: blocked");
    expect(err.statusCode).toBe(500);
  });
});
