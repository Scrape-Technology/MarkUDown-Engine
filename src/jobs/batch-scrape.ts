import { Job } from "bullmq";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { childLogger } from "../utils/logger.js";
import type { ScrapeJobData } from "./scrape.js";

export interface BatchScrapeJobData {
  urls: string[];
  options?: ScrapeJobData["options"];
}

interface BatchPage {
  url: string;
  markdown: string;
  html?: string;
  links: string[];
  metadata: { title: string; description: string; source: string; statusCode: number };
  error?: string;
}

export interface BatchScrapeJobResult {
  success: boolean;
  total: number;
  completed: number;
  failed: number;
  data: BatchPage[];
  processing_time_ms: number;
}

export async function processBatchScrapeJob(job: Job<BatchScrapeJobData>): Promise<BatchScrapeJobResult> {
  const log = childLogger({ jobId: job.id, queue: "batch-scrape" });
  const start = Date.now();
  const { urls, options = {} } = job.data;

  log.info("Batch scrape started", { count: urls.length });

  const results: BatchPage[] = [];
  let failed = 0;

  // Process in chunks of 5
  const chunkSize = 5;
  for (let i = 0; i < urls.length; i += chunkSize) {
    const chunk = urls.slice(i, i + chunkSize);

    const chunkResults = await Promise.allSettled(
      chunk.map(async (url) => {
        const result = await extract(url, {
          timeout: options.timeout ? options.timeout * 1000 : undefined,
        });
        const cleaned = cleanHtml(result.html, url, {
          excludeTags: options.exclude_tags,
          mainContent: options.main_content,
          includeLinks: options.include_link,
        });
        const markdown = result.markdown ?? (await convertToMarkdown(cleaned.html));

        return {
          url,
          markdown,
          html: options.include_html ? cleaned.html : undefined,
          links: cleaned.links,
          metadata: {
            title: cleaned.title,
            description: cleaned.description,
            source: result.source,
            statusCode: result.statusCode,
          },
        } as BatchPage;
      }),
    );

    for (let j = 0; j < chunkResults.length; j++) {
      const r = chunkResults[j];
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        failed++;
        results.push({
          url: chunk[j],
          markdown: "",
          links: [],
          metadata: { title: "", description: "", source: "error", statusCode: 0 },
          error: r.reason?.message || "Unknown error",
        });
      }
    }

    await job.updateProgress(Math.round(((i + chunk.length) / urls.length) * 100));
  }

  log.info("Batch scrape completed", { total: urls.length, completed: results.length - failed, failed, ms: Date.now() - start });

  return {
    success: true,
    total: urls.length,
    completed: results.length - failed,
    failed,
    data: results,
    processing_time_ms: Date.now() - start,
  };
}
