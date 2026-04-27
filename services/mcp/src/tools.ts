import { z } from "zod";
import { addJob, waitForJob } from "./bullmq-client.js";

// ---------------------------------------------------------------------------
// Shared result helper
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

function ok(result: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

function err(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions — each exported as { name, description, schema, handler }
// ---------------------------------------------------------------------------

// ── scrape ──────────────────────────────────────────────────────────────────

export const scrapeSchema = z.object({
  url: z.string().url().describe("The URL to scrape"),
  main_content: z
    .boolean()
    .optional()
    .describe("Extract only main content, stripping navigation/ads"),
  include_links: z
    .boolean()
    .optional()
    .describe("Include hyperlinks found on the page"),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Request timeout in seconds (default: 60)"),
});

export type ScrapeInput = z.infer<typeof scrapeSchema>;

export async function handleScrape(input: ScrapeInput): Promise<ToolResult> {
  try {
    const jobData = {
      url: input.url,
      options: {
        main_content: input.main_content,
        include_link: input.include_links,
        timeout: input.timeout,
      },
    };
    const jobId = await addJob("scrape", jobData);
    const result = await waitForJob("scrape", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── map ─────────────────────────────────────────────────────────────────────

export const mapSchema = z.object({
  url: z.string().url().describe("Root URL to map"),
  max_urls: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of URLs to discover (default: 1000)"),
  allowed_words: z
    .array(z.string())
    .optional()
    .describe("Only include URLs containing these words"),
  blocked_words: z
    .array(z.string())
    .optional()
    .describe("Exclude URLs containing these words"),
});

export type MapInput = z.infer<typeof mapSchema>;

export async function handleMap(input: MapInput): Promise<ToolResult> {
  try {
    const jobData = {
      url: input.url,
      options: {
        max_urls: input.max_urls,
        allowed_words: input.allowed_words,
        blocked_words: input.blocked_words,
      },
    };
    const jobId = await addJob("map", jobData);
    const result = await waitForJob("map", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── crawl ────────────────────────────────────────────────────────────────────

export const crawlSchema = z.object({
  url: z.string().url().describe("Starting URL to crawl"),
  max_depth: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Maximum link depth to follow (default: 5)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of pages to crawl (default: 1000)"),
  main_content: z
    .boolean()
    .optional()
    .describe("Extract only main content on each page"),
});

export type CrawlInput = z.infer<typeof crawlSchema>;

export async function handleCrawl(input: CrawlInput): Promise<ToolResult> {
  try {
    const jobData = {
      url: input.url,
      options: {
        max_depth: input.max_depth,
        limit: input.limit,
        main_content: input.main_content,
      },
    };
    const jobId = await addJob("crawl", jobData);
    const result = await waitForJob("crawl", jobId, 300_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── search ───────────────────────────────────────────────────────────────────

export const searchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of results to return (default: 5)"),
  lang: z
    .string()
    .optional()
    .describe("Language code for search results, e.g. 'en' or 'pt' (default: 'pt')"),
  country: z
    .string()
    .optional()
    .describe("Country code for localised results, e.g. 'us' or 'br' (default: 'br')"),
  scrape_results: z
    .boolean()
    .optional()
    .describe("Whether to scrape each search result page for full content (default: true)"),
});

export type SearchInput = z.infer<typeof searchSchema>;

export async function handleSearch(input: SearchInput): Promise<ToolResult> {
  try {
    const jobData = {
      query: input.query,
      options: {
        limit: input.limit,
        lang: input.lang,
        country: input.country,
        scrape_results: input.scrape_results,
      },
    };
    const jobId = await addJob("search", jobData);
    const result = await waitForJob("search", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── extract ──────────────────────────────────────────────────────────────────

export const extractSchema = z.object({
  url: z.string().url().describe("URL to scrape and extract structured data from"),
  prompt: z
    .string()
    .min(1)
    .describe(
      "Natural-language prompt describing what data to extract, e.g. 'Extract all product names and prices'",
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Request timeout in seconds (default: 60)"),
});

export type ExtractInput = z.infer<typeof extractSchema>;

export async function handleExtract(input: ExtractInput): Promise<ToolResult> {
  try {
    const jobData = {
      url: input.url,
      prompt: input.prompt,
      options: {
        timeout: input.timeout,
      },
    };
    const jobId = await addJob("extract", jobData);
    const result = await waitForJob("extract", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── batch_scrape ─────────────────────────────────────────────────────────────

export const batchScrapeSchema = z.object({
  urls: z.array(z.string().url()).min(1).describe("List of URLs to scrape"),
  main_content: z
    .boolean()
    .optional()
    .describe("Extract only main content on each page"),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Per-page timeout in seconds (default: 60)"),
});

export type BatchScrapeInput = z.infer<typeof batchScrapeSchema>;

export async function handleBatchScrape(input: BatchScrapeInput): Promise<ToolResult> {
  try {
    const jobData = {
      urls: input.urls,
      options: {
        main_content: input.main_content,
        timeout: input.timeout,
      },
    };
    const jobId = await addJob("batch-scrape", jobData);
    const result = await waitForJob("batch-scrape", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── screenshot ───────────────────────────────────────────────────────────────

export const screenshotSchema = z.object({
  url: z.string().url().describe("URL to take a screenshot of"),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Navigation timeout in seconds (default: 60)"),
});

export type ScreenshotInput = z.infer<typeof screenshotSchema>;

export async function handleScreenshot(input: ScreenshotInput): Promise<ToolResult> {
  try {
    const jobData = {
      url: input.url,
      options: {
        timeout: input.timeout,
      },
    };
    const jobId = await addJob("screenshot", jobData);
    const result = await waitForJob("screenshot", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── deep_research ─────────────────────────────────────────────────────────────

export const deepResearchSchema = z.object({
  query: z.string().min(1).describe("Research question or topic"),
  urls: z
    .array(z.string().url())
    .min(1)
    .describe("URLs to scrape as source material for the research"),
  max_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum tokens for the generated research report"),
});

export type DeepResearchInput = z.infer<typeof deepResearchSchema>;

export async function handleDeepResearch(input: DeepResearchInput): Promise<ToolResult> {
  try {
    const jobData = {
      query: input.query,
      urls: input.urls,
      options: {
        max_tokens: input.max_tokens,
      },
    };
    const jobId = await addJob("deep-research", jobData);
    const result = await waitForJob("deep-research", jobId, 300_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── instagram ────────────────────────────────────────────────────────────────

export const instagramSchema = z.object({
  resource: z
    .enum(["profile", "post", "hashtag", "search"])
    .describe('"profile" | "post" | "hashtag" | "search"'),
  target: z
    .string()
    .min(1)
    .describe(
      "Username (profile), post URL or shortcode (post), hashtag without # (hashtag), or search query (search)",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max items for hashtag/search (default: 20, max: 50)"),
  session_cookie: z
    .string()
    .optional()
    .describe('Instagram session cookie, e.g. "sessionid=abc123". Recommended for authenticated content.'),
});

export type InstagramInput = z.infer<typeof instagramSchema>;

export async function handleInstagram(input: InstagramInput): Promise<ToolResult> {
  try {
    const jobId = await addJob("instagram", {
      resource: input.resource,
      target: input.target,
      limit: input.limit,
      session_cookie: input.session_cookie,
    });
    const result = await waitForJob("instagram", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── x ────────────────────────────────────────────────────────────────────────

export const xSchema = z.object({
  resource: z
    .enum(["profile", "post", "search"])
    .describe('"profile" | "post" | "search"'),
  target: z
    .string()
    .min(1)
    .describe(
      "Username (profile), post URL (post), or search query — keywords, @mentions, or #hashtags (search)",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max posts for search (default: 20, max: 50)"),
  session_cookie: z
    .string()
    .optional()
    .describe('X session cookies: "auth_token=abc; ct0=xyz". Recommended for full content access.'),
});

export type XInput = z.infer<typeof xSchema>;

export async function handleX(input: XInput): Promise<ToolResult> {
  try {
    const jobId = await addJob("x", {
      resource: input.resource,
      target: input.target,
      limit: input.limit,
      session_cookie: input.session_cookie,
    });
    const result = await waitForJob("x", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── change_detection ──────────────────────────────────────────────────────────

export const changeDetectionSchema = z.object({
  url: z.string().url().describe("URL to check for content changes"),
  include_diff: z
    .boolean()
    .optional()
    .describe(
      "Include the previous and current markdown in the response so diffs can be computed (default: false)",
    ),
});

export type ChangeDetectionInput = z.infer<typeof changeDetectionSchema>;

export async function handleChangeDetection(input: ChangeDetectionInput): Promise<ToolResult> {
  try {
    const jobData = {
      url: input.url,
      options: {
        include_diff: input.include_diff,
      },
    };
    const jobId = await addJob("change-detection", jobData);
    const result = await waitForJob("change-detection", jobId, 120_000);
    return ok(result);
  } catch (e) {
    return err((e as Error).message);
  }
}
