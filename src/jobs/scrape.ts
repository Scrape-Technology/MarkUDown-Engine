import { Job } from "bullmq";
import { extract } from "../engine/orchestrator.js";
import { llmFetch } from "../utils/llm-fetch.js";
import { type PageAction } from "../engine/playwright-engine.js";
import { type AbrasioOptions } from "../engine/abrasio-engine.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { getOrCompute, type CacheOptions } from "../utils/cache.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";

export interface ScrapeJobData {
  url: string;
  options?: {
    timeout?: number;
    exclude_tags?: string[];
    main_content?: boolean;
    include_link?: boolean;
    include_html?: boolean;
    force_playwright?: boolean;
    force_abrasio?: boolean;
    actions?: PageAction[];
    wait_until?: "domcontentloaded" | "load" | "networkidle";
    cache?: CacheOptions;
    formats?: ("markdown" | "summary")[];
    summary_language?: string;
    abrasio?: AbrasioOptions;
  };
}

export interface ScrapeJobResult {
  success: boolean;
  data: {
    url: string;
    markdown: string;
    summary?: string;
    key_points?: string[];
    html?: string;
    links: string[];
    action_screenshots?: string[];
    metadata: {
      title: string;
      description: string;
      source: string;
      statusCode: number;
    };
  };
  processing_time_ms: number;
}

export async function processScrapeJob(job: Job<ScrapeJobData>): Promise<ScrapeJobResult> {
  const log = childLogger({ jobId: job.id, queue: "scrape" });
  const start = Date.now();
  const { url, options = {} } = job.data;

  log.info("Scrape started", { url });

  const doScrape = async (): Promise<ScrapeJobResult["data"]> => {
    // 1. Extract HTML via orchestrator (Cheerio → Playwright → Abrasio)
    const result = await extract(url, {
      timeout: options.timeout ? options.timeout * 1000 : undefined,
      forcePlaywright: options.force_playwright,
      forceAbrasio: options.force_abrasio,
      actions: options.actions,
      waitUntil: options.wait_until,
      abrasio: options.abrasio,
    });

    // 2. Clean HTML
    const cleaned = await cleanHtml(result.html, url, {
      excludeTags: options.exclude_tags,
      mainContent: options.main_content,
      includeLinks: options.include_link,
    });

    // 3. Convert to Markdown (use Abrasio markdown if available, else Go service)
    const markdown = result.markdown ?? (await convertToMarkdown(cleaned.html));

    // 4. Generate summary if requested
    let summary: string | undefined;
    let keyPoints: string[] | undefined;
    const wantsSummary = options.formats?.includes("summary");

    if (wantsSummary) {
      try {
        const summaryRes = await llmFetch("/summarize/", {
          url,
          markdown: markdown.slice(0, 40000),
          language: options.summary_language ?? undefined,
        }, 60_000);
        if (summaryRes.ok) {
          const summaryData = (await summaryRes.json()) as {
            success: boolean;
            summary: string;
            key_points: string[];
          };
          summary = summaryData.summary;
          keyPoints = summaryData.key_points;
        }
      } catch (err) {
        log.warn("Summary generation failed, continuing without summary", {
          error: (err as Error).message,
        });
      }
    }

    log.info("Scrape completed", { url, source: result.source, ms: Date.now() - start });

    return {
      url,
      markdown,
      summary,
      key_points: keyPoints,
      html: options.include_html ? cleaned.html : undefined,
      links: cleaned.links,
      action_screenshots: result.actionScreenshots,
      metadata: {
        title: cleaned.title,
        description: cleaned.description,
        source: result.source,
        statusCode: result.statusCode,
      },
    };
  };

  // Cache disabled: unchanged behavior, no Redis round-trips at all.
  if (!options.cache?.enabled) {
    return { success: true, data: await doScrape(), processing_time_ms: Date.now() - start };
  }

  // Cache enabled: single-flight — concurrent identical requests (same
  // url+options) share one doScrape() call instead of each redoing the
  // fetch/render/convert work. See cache.ts's getOrCompute().
  const { data, fromCache } = await getOrCompute(url, options, options.cache.maxAge ?? 3600, doScrape);
  if (fromCache) {
    log.info("Scrape served from cache (or coalesced with an in-flight request)", { url });
  }

  return {
    success: true,
    data,
    processing_time_ms: Date.now() - start,
  };
}
