import { describe, it, expect } from "vitest";
import { sampleRepeatingElements } from "../engine/structure-analyzer.js";

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
