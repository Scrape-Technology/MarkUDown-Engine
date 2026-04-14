import { describe, it, expect, vi, beforeEach } from "vitest";
import { sampleRepeatingElements, analyzeStructure, extractWithSelectors } from "../engine/structure-analyzer.js";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

import { fetch } from "undici";

describe("sampleRepeatingElements", () => {
  it("returns a sample when <tr> elements repeat >= 3 times", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td><td>Maceio</td></tr>
      <tr><td>BA</td><td>Club 2</td><td>Salvador</td></tr>
      <tr><td>CE</td><td>Club 3</td><td>Fortaleza</td></tr>
    </tbody></table>`;
    const sample = sampleRepeatingElements(html);
    expect(sample).not.toBeNull();
    expect(sample).toContain("Club 1");
    expect(sample).toContain("Club 2");
  });

  it("returns a sample when <li> elements repeat >= 3 times", () => {
    const html = `<ul>
      <li class="item">Item 1</li>
      <li class="item">Item 2</li>
      <li class="item">Item 3</li>
    </ul>`;
    const sample = sampleRepeatingElements(html);
    expect(sample).not.toBeNull();
    expect(sample).toContain("Item 1");
  });

  it("returns null when no element appears >= 3 times", () => {
    const html = `<div><p>One</p><p>Two</p></div>`;
    expect(sampleRepeatingElements(html)).toBeNull();
  });

  it("caps output at 3000 chars", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      `<tr><td>UF${i}</td><td>Club ${i}</td><td>City ${i}</td></tr>`
    ).join("\n");
    const html = `<table><tbody>${rows}</tbody></table>`;
    const sample = sampleRepeatingElements(html);
    expect(sample).not.toBeNull();
    expect(sample!.length).toBeLessThanOrEqual(3000);
  });

  it("returns null for empty string input", () => {
    expect(sampleRepeatingElements("")).toBeNull();
  });

  it("contains parent container tag in result", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td></tr>
      <tr><td>BA</td><td>Club 2</td></tr>
      <tr><td>CE</td><td>Club 3</td></tr>
    </tbody></table>`;
    const sample = sampleRepeatingElements(html);
    expect(sample).not.toBeNull();
    // Must contain a container tag, not just bare <tr> elements
    expect(sample).toMatch(/<tbody|<table/i);
  });

  it("handles top-level repeating elements (body parent fallback)", () => {
    const html = `<li>A</li><li>B</li><li>C</li>`;
    const sample = sampleRepeatingElements(html);
    expect(sample).not.toBeNull();
    expect(sample).toContain("<li>");
  });
});

describe("analyzeStructure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no repeating elements found", async () => {
    const html = `<div><p>One</p><p>Two</p></div>`;
    const result = await analyzeStructure(html, { clube: "string", uf: "string" }, "extract clubs");
    expect(result).toBeNull();
  });

  it("returns PageStructure on successful LLM response", async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: JSON.stringify({
          container: "tbody tr",
          fields: { uf: "td:nth-child(1)", clube: "td:nth-child(2)" },
          confidence: "high",
        }),
      }),
    });

    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td></tr>
      <tr><td>BA</td><td>Club 2</td></tr>
      <tr><td>CE</td><td>Club 3</td></tr>
    </tbody></table>`;

    const result = await analyzeStructure(html, { uf: "string", clube: "string" }, "extract clubs");
    expect(result).not.toBeNull();
    expect(result!.container).toBe("tbody tr");
    expect(result!.fields.uf).toBe("td:nth-child(1)");
    expect(result!.confidence).toBe("high");
  });

  it("returns null when LLM call fails", async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const html = `<table><tbody>
      <tr><td>A</td></tr><tr><td>B</td></tr><tr><td>C</td></tr>
    </tbody></table>`;

    const result = await analyzeStructure(html, { field: "string" }, "extract");
    expect(result).toBeNull();
  });

  it("returns null when confidence is low", async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: JSON.stringify({
          container: "div",
          fields: { field: null },
          confidence: "low",
        }),
      }),
    });

    const html = `<table><tbody>
      <tr><td>A</td></tr><tr><td>B</td></tr><tr><td>C</td></tr>
    </tbody></table>`;

    const result = await analyzeStructure(html, { field: "string" }, "extract");
    expect(result).toBeNull();
  });
});

describe("extractWithSelectors", () => {
  it("extracts all records from matching containers", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>Maceio FC</td></tr>
      <tr><td>BA</td><td>Salvador United</td></tr>
      <tr><td>CE</td><td>Fortaleza SC</td></tr>
    </tbody></table>`;

    const structure = {
      container: "tbody tr",
      fields: {
        uf: "td:nth-child(1)",
        clube: "td:nth-child(2)",
      },
      confidence: "high" as const,
    };

    const result = extractWithSelectors(html, structure);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ uf: "AL", clube: "Maceio FC" });
    expect(result[1]).toEqual({ uf: "BA", clube: "Salvador United" });
    expect(result[2]).toEqual({ uf: "CE", clube: "Fortaleza SC" });
  });

  it("returns empty array when container selector matches nothing", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td></tr>
      <tr><td>BA</td><td>Club 2</td></tr>
    </tbody></table>`;

    const structure = {
      container: "div.record",
      fields: {
        uf: "td:nth-child(1)",
        clube: "td:nth-child(2)",
      },
      confidence: "high" as const,
    };

    const result = extractWithSelectors(html, structure);
    expect(result).toEqual([]);
  });

  it("sets field to null when selector is null", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td></tr>
      <tr><td>BA</td><td>Club 2</td></tr>
      <tr><td>CE</td><td>Club 3</td></tr>
    </tbody></table>`;

    const structure = {
      container: "tbody tr",
      fields: {
        uf: "td:nth-child(1)",
        phone: null,
      },
      confidence: "high" as const,
    };

    const result = extractWithSelectors(html, structure);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ uf: "AL", phone: null });
    expect(result[1]).toEqual({ uf: "BA", phone: null });
    expect(result[2]).toEqual({ uf: "CE", phone: null });
  });

  it("filters out records where all fields are null", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td></tr>
      <tr><td></td><td></td></tr>
      <tr><td>BA</td><td>Club 2</td></tr>
      <tr><td></td><td></td></tr>
    </tbody></table>`;

    const structure = {
      container: "tbody tr",
      fields: {
        uf: "td:nth-child(1)",
        clube: "td:nth-child(2)",
      },
      confidence: "high" as const,
    };

    const result = extractWithSelectors(html, structure);

    // Should only include the 2 non-empty rows, filtering out the empty ones
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ uf: "AL", clube: "Club 1" });
    expect(result[1]).toEqual({ uf: "BA", clube: "Club 2" });
  });

  it("sets field to null when selector matches no element", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td></tr>
      <tr><td>BA</td><td>Club 2</td></tr>
    </tbody></table>`;

    const structure = {
      container: "tbody tr",
      fields: {
        uf: "td:nth-child(1)",
        phone: "span.missing",
      },
      confidence: "high" as const,
    };

    const result = extractWithSelectors(html, structure);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ uf: "AL", phone: null });
    expect(result[1]).toEqual({ uf: "BA", phone: null });
  });
});
