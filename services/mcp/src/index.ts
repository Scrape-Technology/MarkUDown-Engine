import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { closeAll } from "./bullmq-client.js";
import {
  scrapeSchema,
  handleScrape,
  mapSchema,
  handleMap,
  crawlSchema,
  handleCrawl,
  searchSchema,
  handleSearch,
  extractSchema,
  handleExtract,
  batchScrapeSchema,
  handleBatchScrape,
  screenshotSchema,
  handleScreenshot,
  deepResearchSchema,
  handleDeepResearch,
  changeDetectionSchema,
  handleChangeDetection,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Build server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "markudown-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ── Register tools ──────────────────────────────────────────────────────────
// The SDK validates `args` against the schema before calling the handler,
// so we pass the raw Zod shape and receive typed + validated arguments.

server.tool(
  "scrape",
  "Scrape a single URL and return its content as Markdown. Uses a multi-layer engine (Cheerio → Playwright → Abrasio) for maximum compatibility.",
  scrapeSchema.shape,
  async (args) => handleScrape(args),
);

server.tool(
  "map",
  "Discover all URLs on a website by parsing its sitemap and crawling the root page. Returns a deduplicated list of internal links.",
  mapSchema.shape,
  async (args) => handleMap(args),
);

server.tool(
  "crawl",
  "Recursively crawl a website starting from a root URL, following internal links up to a configurable depth and page limit. Returns Markdown for every page visited.",
  crawlSchema.shape,
  async (args) => handleCrawl(args),
);

server.tool(
  "search",
  "Perform a Google search and optionally scrape each result page for full Markdown content.",
  searchSchema.shape,
  async (args) => handleSearch(args),
);

server.tool(
  "extract",
  "Scrape a URL then use an LLM to extract structured data described by a natural-language prompt.",
  extractSchema.shape,
  async (args) => handleExtract(args),
);

server.tool(
  "batch_scrape",
  "Scrape multiple URLs concurrently and return Markdown for each page.",
  batchScrapeSchema.shape,
  async (args) => handleBatchScrape(args),
);

server.tool(
  "screenshot",
  "Take a full-page screenshot of a URL and return it as a base64-encoded PNG.",
  screenshotSchema.shape,
  async (args) => handleScreenshot(args),
);

server.tool(
  "deep_research",
  "Scrape a set of URLs then synthesise a research report using an LLM, grounded in the scraped content.",
  deepResearchSchema.shape,
  async (args) => handleDeepResearch(args),
);

server.tool(
  "change_detection",
  "Check whether a URL's content has changed since the last time it was checked. Hashes are stored in Redis.",
  changeDetectionSchema.shape,
  async (args) => handleChangeDetection(args),
);

// ---------------------------------------------------------------------------
// Transport selection and startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  if (transport === "http") {
    const port = parseInt(process.env.MCP_PORT ?? "3010", 10);

    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — each request is independent
    });

    const httpServer = createServer((req, res) => {
      void httpTransport.handleRequest(req, res);
    });

    await server.connect(httpTransport);

    httpServer.listen(port, () => {
      console.error(`[markudown-mcp] HTTP transport listening on port ${port}`);
    });
  } else {
    // Default: stdio (used by Claude Desktop and most MCP hosts)
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error("[markudown-mcp] stdio transport ready");
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.error(`[markudown-mcp] Received ${signal}, shutting down...`);
  await closeAll();
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

main().catch((error: unknown) => {
  console.error("[markudown-mcp] Fatal startup error:", error);
  process.exit(1);
});
