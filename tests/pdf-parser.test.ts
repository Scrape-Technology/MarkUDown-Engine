import { describe, it, expect } from "vitest";
import { isPdfUrl } from "../src/processors/pdf-parser.js";

describe("isPdfUrl", () => {
  it("detects .pdf extension", () => {
    expect(isPdfUrl("https://example.com/doc.pdf")).toBe(true);
  });

  it("detects .pdf with query params", () => {
    expect(isPdfUrl("https://example.com/doc.pdf?page=1")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isPdfUrl("https://example.com/doc.PDF")).toBe(true);
  });

  it("rejects non-pdf URLs", () => {
    expect(isPdfUrl("https://example.com/page.html")).toBe(false);
    expect(isPdfUrl("https://example.com/pdf-viewer")).toBe(false);
  });
});
