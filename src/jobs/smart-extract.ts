// MarkUDown-Engine/src/jobs/smart-extract.ts
import { Job } from "bullmq";
import { childLogger } from "../utils/logger.js";
import { analyzeSite } from "../engine/site-analyzer.js";
import { planExtraction } from "../engine/extraction-planner.js";
import { executeNavigation } from "../engine/guided-executor.js";
import { analyzeStructure, extractWithSelectors } from "../engine/structure-analyzer.js";

export interface SmartExtractJobData {
  url: string;
  goal: string;
  hints?: string[];
  schema?: Record<string, string>;
  output_format?: "markdown" | "json" | "csv";
  max_pages?: number;
  options?: {
    timeout?: number;
  };
}

export interface SmartExtractJobResult {
  success: boolean;
  data: {
    url: string;
    markdown: string;
    json_data?: unknown[];
    metadata: {
      layer_used: string;
      pages_traversed: number;
      records_extracted: number;
      difficulty: string;
      actions_executed: number;
      planner_reasoning: string;
      duration_ms: number;
    };
  };
  processing_time_ms: number;
}

/**
 * Smart Extract job: 3-phase extraction.
 * Phase A — site analysis (difficulty, interactive elements)
 * Phase B — LLM-based action planning
 * Phase C — guided execution with pagination + completeness validation
 * Phase C2+C3 — selector-based structured extraction (replaces old Phase D)
 */

export async function processSmartExtractJob(
  job: Job<SmartExtractJobData>,
): Promise<SmartExtractJobResult> {
  const log = childLogger({ jobId: job.id, queue: "smart-extract" });
  const start = Date.now();
  const {
    url,
    goal,
    hints = [],
    schema,
    output_format = "markdown",
    max_pages = 20,
    options = {},
  } = job.data;
  const timeout = (options.timeout ?? 60) * 1_000;

  log.info("Smart extract started", { url, goal: goal.slice(0, 80), output_format });

  // Phase A: Analyze site
  await job.updateProgress({ phase: "analyzing", pct: 10 });
  const siteMap = await analyzeSite(url, timeout);

  // Phase B: Plan extraction
  await job.updateProgress({ phase: "planning", pct: 35 });
  const plan = await planExtraction(goal, hints, siteMap, max_pages);

  // Phase C: Execute + validate
  await job.updateProgress({ phase: "executing", pct: 60 });
  const result = await executeNavigation(url, plan, siteMap.difficulty, timeout);

  // Phase C2+C3: Selector-based structured extraction (only when output_format === "json" and schema provided)
  await job.updateProgress({ phase: "structuring", pct: 80 });
  let jsonData: unknown[] | undefined;
  if (output_format === "json" && schema) {
    log.info("Smart extract: analyzing DOM structure for selectors");
    const structure = await analyzeStructure(result.html, schema, goal);
    if (structure) {
      const extracted = extractWithSelectors(result.html, structure);
      if (extracted.length > 0) {
        jsonData = extracted;
        log.info("Smart extract: selector extraction complete", { records: extracted.length });
      } else {
        log.warn("Smart extract: cheerio found 0 records, returning raw markdown");
      }
    } else {
      log.warn("Smart extract: structure analysis failed, returning raw markdown");
    }
  }

  const durationMs = Date.now() - start;
  await job.updateProgress({ phase: "done", pct: 100 });

  log.info("Smart extract completed", {
    url,
    layer: result.layerUsed,
    pages: result.pagesTraversed,
    records: jsonData ? jsonData.length : result.recordsExtracted,
    ms: durationMs,
  });

  return {
    success: true,
    data: {
      url,
      markdown: result.markdown,
      ...(jsonData !== undefined && { json_data: jsonData }),
      metadata: {
        layer_used: result.layerUsed,
        pages_traversed: result.pagesTraversed,
        records_extracted: jsonData ? jsonData.length : result.recordsExtracted,
        difficulty: siteMap.difficulty,
        actions_executed: plan.actions.length,
        planner_reasoning: plan.reasoning,
        duration_ms: durationMs,
      },
    },
    processing_time_ms: durationMs,
  };
}
