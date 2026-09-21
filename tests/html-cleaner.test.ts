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
  it("extracts title and description", async () => {
    const result = await cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.title).toBe("Test Page");
    expect(result.description).toBe("A test description");
  });

  it("removes script and style tags", async () => {
    const result = await cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.html).not.toContain("alert");
    expect(result.html).not.toContain("color: red");
  });

  it("removes nav, header, footer by default", async () => {
    const result = await cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.html).not.toContain("Nav");
    expect(result.html).not.toContain("Header content");
    expect(result.html).not.toContain("Footer content");
  });

  it("strips class, id, style attributes", async () => {
    const result = await cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.html).not.toContain('class="intro"');
    expect(result.html).not.toContain('id="p1"');
    expect(result.html).not.toContain('style="color: blue;"');
  });

  it("resolves relative URLs", async () => {
    const result = await cleanHtml(SAMPLE_HTML, "https://example.com");
    expect(result.html).toContain("https://example.com/relative");
    expect(result.html).toContain("https://example.com/img/photo.jpg");
  });

  it("extracts links", async () => {
    const result = await cleanHtml(SAMPLE_HTML, "https://example.com", { includeLinks: true });
    expect(result.links).toContain("https://external.com/page");
  });

  it("extracts main content when mainContent=true", async () => {
    const result = await cleanHtml(SAMPLE_HTML, "https://example.com", { mainContent: true });
    expect(result.html).toContain("Hello World");
    expect(result.html).toContain("This is content.");
  });

  it("removes custom exclude tags", async () => {
    const html = '<html><body><aside>Sidebar</aside><main><p>Content</p></main></body></html>';
    const result = await cleanHtml(html, "https://example.com", { excludeTags: ["aside"] });
    expect(result.html).not.toContain("Sidebar");
    expect(result.html).toContain("Content");
  });

  // Covers the exact gap flagged in the 2026-09-16 MarkUDown audit: a page with
  // no <main>/<article>/role="main" wrapper used to silently fall through to
  // cleanHtml returning the ENTIRE document (sidebar, cookie banner, related
  // links, everything) whenever mainContent:true was requested. Defuddle's
  // density scoring should now pick the real article body over surrounding
  // boilerplate even without one of those three wrapper hints.
  it("picks the dense article body over sidebar/boilerplate when there is no <main>/<article> wrapper", async () => {
    const html = `
      <html>
      <head><title>No Main Wrapper</title></head>
      <body>
        <div class="cookie-banner">
          <p>We use cookies to improve your experience. Accept all cookies to continue browsing this site.</p>
          <button>Accept</button>
        </div>
        <div class="sidebar">
          <h3>Related Articles</h3>
          <ul>
            <li><a href="/a">Five tips for faster onboarding</a></li>
            <li><a href="/b">Why our new pricing makes sense</a></li>
            <li><a href="/c">Customer story: scaling to 10x traffic</a></li>
          </ul>
        </div>
        <div class="article-body">
          <h1>How Content Extraction Actually Works</h1>
          <p>Most scraping pipelines fail not because they can't fetch a page, but because they
          can't tell the difference between the thing a reader came for and everything else sharing
          the same document. A density-based extractor looks at how much of a candidate block is
          real prose versus link text, and how consistently that holds across the block's children,
          before deciding it found the article rather than a list of links dressed up as a section.</p>
          <p>That distinction matters most on exactly the pages naive heuristics get wrong: no
          semantic &lt;main&gt; tag, no ARIA landmark, just a stack of generic divs where only one
          of them is actually what the reader is here for.</p>
        </div>
        <div class="footer-links">
          <a href="/privacy">Privacy</a> <a href="/terms">Terms</a> <a href="/careers">Careers</a>
        </div>
      </body>
      </html>`;
    const result = await cleanHtml(html, "https://example.com", { mainContent: true });
    expect(result.html).toContain("How Content Extraction Actually Works");
    expect(result.html).toContain("density-based extractor");
    expect(result.html).not.toContain("Accept all cookies");
    expect(result.html).not.toContain("Related Articles");
    expect(result.html).not.toContain("Careers");
  });
});
