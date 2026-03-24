import { Job } from "bullmq";
import { fetch } from "undici";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";

export interface DeepResearchJobData {
  query: string;
  urls: string[];
  options?: {
    timeout?: number;
    max_tokens?: number;
  };
}

export interface DeepResearchJobResult {
  success: boolean;
  research: string;
  sources: string[];
  pages_analyzed: number;
  processing_time_ms: number;
}

/**
 * Deep research job: scrape multiple URLs, then send all content to
 * Python LLM service for synthesized research report.
 *
 * Flow: TS Worker (scrape N pages) → Python LLM Service (deep-research) → report
 */
export async function processDeepResearchJob(
  job: Job<DeepResearchJobData>,
): Promise<DeepResearchJobResult> {
  const log = childLogger({ jobId: job.id, queue: "deep-research" });
  const start = Date.now();
  const { query, urls, options = {} } = job.data;

  log.info("Deep research started", { query, urlCount: urls.length });

  // 1. Scrape all pages in parallel (limited concurrency)
  const pages: { url: string; markdown: string; title: string }[] = [];
  const chunkSize = 5;

  for (let i = 0; i < urls.length; i += chunkSize) {
    const chunk = urls.slice(i, i + chunkSize);

    const results = await Promise.allSettled(
      chunk.map(async (url) => {
        const result = await extract(url, {
          timeout: options.timeout ? options.timeout * 1000 : 30_000,
        });
        const cleaned = cleanHtml(result.html, url, { mainContent: true });
        const markdown = result.markdown ?? (await convertToMarkdown(cleaned.html));
        return { url, markdown, title: cleaned.title };
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        pages.push(r.value);
      }
    }

    await job.updateProgress(Math.round(((i + chunk.length) / urls.length) * 50));
  }

  if (pages.length === 0) {
    throw new Error("Failed to scrape any of the provided URLs");
  }

  log.info("Pages scraped, sending to LLM", { scraped: pages.length, total: urls.length });
  await job.updateProgress(60);

  // 2. Send to Python LLM service for synthesis
  const llmResponse = await fetch(`${config.PYTHON_LLM_URL}/deep-research/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      pages: pages.map((p) => ({ url: p.url, markdown: p.markdown, title: p.title })),
      max_tokens: options.max_tokens,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!llmResponse.ok) {
    const errorText = await llmResponse.text();
    throw new Error(`Python LLM service returned ${llmResponse.status}: ${errorText}`);
  }

  const llmResult = (await llmResponse.json()) as {
    success: boolean;
    research: string;
    sources: string[];
    pages_analyzed: number;
  };

  await job.updateProgress(100);
  log.info("Deep research completed", {
    query,
    pagesAnalyzed: llmResult.pages_analyzed,
    ms: Date.now() - start,
  });

  return {
    success: true,
    research: llmResult.research,
    sources: llmResult.sources,
    pages_analyzed: llmResult.pages_analyzed,
    processing_time_ms: Date.now() - start,
  };
}
