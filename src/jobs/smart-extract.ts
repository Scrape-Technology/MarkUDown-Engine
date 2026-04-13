// MarkUDown-Engine/src/jobs/smart-extract.ts
import { Job } from "bullmq";
import { childLogger } from "../utils/logger.js";
import { analyzeSite } from "../engine/site-analyzer.js";
import { planExtraction } from "../engine/extraction-planner.js";
import { executeExtraction } from "../engine/guided-executor.js";

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
 */
export async function processSmartExtractJob(
  job: Job<SmartExtractJobData>,
): Promise<SmartExtractJobResult> {
  const log = childLogger({ jobId: job.id, queue: "smart-extract" });
  const start = Date.now();
  const { url, goal, hints = [], schema, max_pages = 20, options = {} } = job.data;
  const timeout = (options.timeout ?? 60) * 1_000;

  log.info("Smart extract started", { url, goal: goal.slice(0, 80) });

  // Phase A: Analyze site
  await job.updateProgress({ phase: "analyzing", pct: 10 });
  const siteMap = await analyzeSite(url, timeout);

  // Phase B: Plan extraction
  await job.updateProgress({ phase: "planning", pct: 35 });
  const plan = await planExtraction(goal, hints, siteMap, max_pages);

  // Phase C: Execute + validate
  await job.updateProgress({ phase: "executing", pct: 60 });
  const result = await executeExtraction(url, plan, siteMap.difficulty, schema, timeout);

  await job.updateProgress({ phase: "validating", pct: 90 });

  const durationMs = Date.now() - start;
  await job.updateProgress({ phase: "done", pct: 100 });

  log.info("Smart extract completed", {
    url,
    layer: result.layerUsed,
    pages: result.pagesTraversed,
    records: result.recordsExtracted,
    ms: durationMs,
  });

  return {
    success: true,
    data: {
      url,
      markdown: result.markdown,
      metadata: {
        layer_used: result.layerUsed,
        pages_traversed: result.pagesTraversed,
        records_extracted: result.recordsExtracted,
        difficulty: siteMap.difficulty,
        actions_executed: plan.actions.length,
        planner_reasoning: plan.reasoning,
        duration_ms: durationMs,
      },
    },
    processing_time_ms: durationMs,
  };
}
