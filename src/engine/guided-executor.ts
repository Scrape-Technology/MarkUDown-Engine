// MarkUDown-Engine/src/engine/guided-executor.ts
import { extract } from "./orchestrator.js";
import { playwrightFetch } from "./playwright-engine.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { logger } from "../utils/logger.js";
import type { Difficulty } from "./site-analyzer.js";
import type { ExtractionPlan } from "./extraction-planner.js";

export interface ExecutionResult {
  markdown: string;
  pagesTraversed: number;
  recordsExtracted: number;
  layerUsed: "patchright" | "abrasio-local" | "abrasio-cloud";
}

function countTableRows(markdown: string): number {
  return markdown
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|[-: |]+\|$/.test(l.trim()))
    .length;
}

function detectNextPage(html: string, currentUrl: string): string | null {
  const patterns = [
    /<link[^>]+rel=["']next["'][^>]*href=["']([^"']+)["']/i,
    /<a[^>]+rel=["']next["'][^>]*href=["']([^"']+)["']/i,
    /<a[^>]+href=["']([^"'#][^"']*?)["'][^>]*>\s*(?:próxima|next|siguiente|→|&gt;|>)\s*<\/a>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) {
      try {
        return new URL(m[1], currentUrl).toString();
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

function layerLabel(difficulty: Difficulty): ExecutionResult["layerUsed"] {
  if (difficulty === "hard") return "abrasio-cloud";
  if (difficulty === "medium") return "abrasio-local";
  return "patchright";
}

/**
 * Phase C: Execute the action plan and extract all content with pagination.
 */
export async function executeExtraction(
  url: string,
  plan: ExtractionPlan,
  difficulty: Difficulty,
  schema: Record<string, string> | undefined,
  timeout: number,
): Promise<ExecutionResult> {
  logger.info("guided-executor: starting", {
    url,
    actions: plan.actions.length,
    difficulty,
  });

  const forceAbrasio = difficulty !== "easy";
  let allMarkdown = "";
  let pagesTraversed = 0;
  let lastHtml = "";
  let retryCount = 0;

  // Execute the action plan on the first page via Patchright
  const firstResult = await playwrightFetch(url, {
    timeout,
    actions: plan.actions,
    skipResourceBlocking: plan.actions.length > 0,
  });

  lastHtml = firstResult.html;
  const cleaned = cleanHtml(firstResult.html, url, {
    mainContent: true,
    includeLinks: false,
  });
  allMarkdown = await convertToMarkdown(cleaned.html);
  pagesTraversed++;

  let currentUrl = url;

  while (pagesTraversed < plan.maxPages) {
    const nextUrl = detectNextPage(lastHtml, currentUrl);
    if (!nextUrl || nextUrl === currentUrl) break;

    try {
      const pageResult = await extract(nextUrl, { timeout, forceAbrasio });
      const pageCleaned = cleanHtml(pageResult.html, nextUrl, {
        mainContent: true,
        includeLinks: false,
      });
      const pageMarkdown =
        pageResult.markdown ?? (await convertToMarkdown(pageCleaned.html));
      allMarkdown += "\n\n" + pageMarkdown;
      lastHtml = pageResult.html;
      currentUrl = nextUrl;
      pagesTraversed++;
    } catch (err: any) {
      logger.warn("guided-executor: pagination page failed", {
        nextUrl,
        error: err.message,
      });
      break;
    }
  }

  // Completeness check: if table looks truncated, retry with Abrasio
  const rowCount = countTableRows(allMarkdown);
  if (rowCount > 0 && rowCount < 5 && retryCount === 0 && difficulty !== "hard") {
    retryCount++;
    logger.info("guided-executor: table looks incomplete, retrying with Abrasio", {
      rowCount,
    });
    try {
      const retryResult = await extract(url, {
        timeout,
        forceAbrasio: true,
        actions: plan.actions,
      });
      const retryCleaned = cleanHtml(retryResult.html, url, {
        mainContent: true,
        includeLinks: false,
      });
      const retryMarkdown =
        retryResult.markdown ?? (await convertToMarkdown(retryCleaned.html));
      if (countTableRows(retryMarkdown) > rowCount) {
        allMarkdown = retryMarkdown;
        pagesTraversed = 1;
      }
    } catch (err: any) {
      logger.warn("guided-executor: retry failed", { error: err.message });
    }
  }

  const recordsExtracted = Math.max(
    countTableRows(allMarkdown),
    allMarkdown.split("\n").filter(Boolean).length,
  );

  logger.info("guided-executor: done", { pagesTraversed, recordsExtracted });

  return {
    markdown: allMarkdown,
    pagesTraversed,
    recordsExtracted,
    layerUsed: layerLabel(difficulty),
  };
}
