import { Job } from "bullmq";
import { fetch } from "undici";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";

export interface ExtractJobData {
  url: string;
  schema?: Record<string, string>;
  prompt?: string;
  extraction_scope?: string;
  extraction_target?: string;
  extract_query?: string;
  options?: {
    timeout?: number;
    main_content?: boolean;
  };
}

export interface ExtractJobResult {
  success: boolean;
  data: Record<string, unknown>[];
  total: number;
  url: string;
  processing_time_ms: number;
}

/**
 * Extract job: scrape URL via orchestrator, then send markdown to Python LLM service
 * for structured data extraction using Gemini.
 *
 * Flow: TS Worker (scrape) → Python LLM Service (extract) → result
 */
export async function processExtractJob(job: Job<ExtractJobData>): Promise<ExtractJobResult> {
  const log = childLogger({ jobId: job.id, queue: "extract" });
  const start = Date.now();
  const { url, schema, prompt, extraction_scope, extraction_target, extract_query, options = {} } = job.data;

  log.info("Extract started", { url, mode: schema ? "schema" : "prompt", schemaFields: schema ? Object.keys(schema) : [] });

  // 1. Scrape the page
  await job.updateProgress(10);
  const result = await extract(url, {
    timeout: options.timeout ? options.timeout * 1000 : undefined,
  });

  const cleaned = cleanHtml(result.html, url, { mainContent: options.main_content ?? true });
  const markdown = result.markdown ?? (await convertToMarkdown(cleaned.html));

  await job.updateProgress(50);

  // 2. Send to Python LLM service for extraction
  const llmResponse = await fetch(`${config.PYTHON_LLM_URL}/extract/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      markdown,
      schema_fields: schema ?? undefined,
      prompt: prompt ?? undefined,
      extraction_scope,
      extraction_target,
      extract_query,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!llmResponse.ok) {
    const errorText = await llmResponse.text();
    throw new Error(`Python LLM service returned ${llmResponse.status}: ${errorText}`);
  }

  const llmResult = (await llmResponse.json()) as {
    success: boolean;
    data: Record<string, unknown>[];
    total: number;
  };

  await job.updateProgress(100);
  log.info("Extract completed", { url, items: llmResult.total, ms: Date.now() - start });

  return {
    success: true,
    data: llmResult.data,
    total: llmResult.total,
    url,
    processing_time_ms: Date.now() - start,
  };
}
