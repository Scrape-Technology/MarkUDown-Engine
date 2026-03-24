import { describe, it, expect } from "vitest";
import { cleanHtml } from "../src/processors/html-cleaner.js";

const SAMPLE_HTML = `
<html>
<head>
  <title>Test Page</title>
  <meta name="description" content="A test description">
  <style>body { color: red; }</style>
  <script>alert('xss')</script>
</head>
<body>
  <nav><a href="/nav">Nav</a></nav>
  <header>Header content</header>
  <main>
    <h1>Hello World</h1>
    <p class="intro" id="p1" style="color: blue;">This is content.</p>
    <a href="/relative">Relative Link</a>
    <a href="https://external.com/page">External Link</a>
    <img src="/img/photo.jpg">
  </main>
  <footer>Footer content</footer>
</body>
</html>`;

describe("cleanHtml", () => {
  it("extracts title and description", () => {
    const result = cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.title).toBe("Test Page");
    expect(result.description).toBe("A test description");
  });

  it("removes script and style tags", () => {
    const result = cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.html).not.toContain("alert");
    expect(result.html).not.toContain("color: red");
  });

  it("removes nav, header, footer by default", () => {
    const result = cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.html).not.toContain("Nav");
    expect(result.html).not.toContain("Header content");
    expect(result.html).not.toContain("Footer content");
  });

  it("strips class, id, style attributes", () => {
    const result = cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.html).not.toContain('class="intro"');
    expect(result.html).not.toContain('id="p1"');
    expect(result.html).not.toContain('style="color: blue;"');
  });

  it("resolves relative URLs", () => {
    const result = cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.html).toContain("https://example.com/relative");
    expect(result.html).toContain("https://example.com/img/photo.jpg");
  });

  it("extracts links", () => {
    const result = cleanHtml(SAMPLE_HTML, "https://example.com", { includeLinks: true });
    expect(result.links).toContain("https://external.com/page");
  });

  it("extracts main content when mainContent=true", () => {
    const result = cleanHtml(SAMPLE_HTML, "https://example.com", { mainContent: true });
    expect(result.html).toContain("Hello World");
    expect(result.html).toContain("This is content.");
  });

  it("removes custom exclude tags", () => {
    const html = '<html><body><aside>Sidebar</aside><main><p>Content</p></main></body></html>';
    const result = cleanHtml(html, "https://example.com", { excludeTags: ["aside"] });
    expect(result.html).not.toContain("Sidebar");
    expect(result.html).toContain("Content");
  });
});
