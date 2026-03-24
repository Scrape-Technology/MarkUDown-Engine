import { Job } from "bullmq";
import { fetch } from "undici";
import { extract } from "../engine/orchestrator.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";

export interface AgentJobData {
  url: string;
  prompt: string;
  options?: {
    timeout?: number;
    max_steps?: number;
    main_content?: boolean;
    include_screenshots?: boolean;
    /** Allow the agent to follow links to other pages */
    allow_navigation?: boolean;
    /** Max pages the agent can visit */
    max_pages?: number;
  };
}

interface AgentStep {
  step: number;
  url: string;
  action: string;
  reasoning: string;
  result?: string;
  screenshot?: string;
}

export interface AgentJobResult {
  success: boolean;
  data: {
    url: string;
    answer: string;
    steps: AgentStep[];
    pages_visited: string[];
    total_steps: number;
  };
  processing_time_ms: number;
}

/**
 * Agent job: AI-driven autonomous web navigation.
 *
 * The agent receives a URL and a prompt, then iteratively:
 * 1. Scrapes the current page
 * 2. Sends the page content + prompt + history to the LLM
 * 3. LLM decides: answer, click a link, extract data, or navigate to a new URL
 * 4. Repeats until the LLM has enough info to answer or max_steps reached
 *
 * Flow: scrape → LLM plan → execute action → repeat → final answer
 */
export async function processAgentJob(job: Job<AgentJobData>): Promise<AgentJobResult> {
  const log = childLogger({ jobId: job.id, queue: "agent" });
  const start = Date.now();
  const { url, prompt, options = {} } = job.data;

  const maxSteps = Math.min(options.max_steps ?? 10, 25);
  const maxPages = Math.min(options.max_pages ?? 5, 15);
  const allowNavigation = options.allow_navigation ?? true;
  const timeout = options.timeout ? options.timeout * 1000 : 60_000;

  log.info("Agent started", { url, prompt: prompt.slice(0, 100), maxSteps, maxPages });

  const steps: AgentStep[] = [];
  const pagesVisited: string[] = [];
  let currentUrl = url;
  let finalAnswer: string | undefined;

  for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {
    await job.updateProgress(Math.round((stepNum / maxSteps) * 90));

    // 1. Scrape current page (if not already visited recently)
    let markdown: string;
    let links: string[] = [];

    if (!pagesVisited.includes(currentUrl) || pagesVisited.length === 0) {
      try {
        const result = await extract(currentUrl, { timeout });
        const cleaned = cleanHtml(result.html, currentUrl, {
          mainContent: options.main_content ?? true,
          includeLinks: true,
        });
        markdown = result.markdown ?? (await convertToMarkdown(cleaned.html));
        links = cleaned.links;
        pagesVisited.push(currentUrl);
      } catch (err: any) {
        log.warn("Agent page scrape failed", { url: currentUrl, error: err.message });
        steps.push({
          step: stepNum,
          url: currentUrl,
          action: "scrape_failed",
          reasoning: `Failed to scrape: ${err.message}`,
        });
        break;
      }
    } else {
      // Already visited, skip re-scrape
      markdown = "[Page already visited, using previous context]";
    }

    // 2. Send to LLM for next action decision
    const llmPayload = {
      prompt,
      current_url: currentUrl,
      page_content: markdown.slice(0, 30_000),
      available_links: links.slice(0, 50),
      steps_so_far: steps,
      pages_visited: pagesVisited,
      step_number: stepNum,
      max_steps: maxSteps,
      allow_navigation: allowNavigation && pagesVisited.length < maxPages,
    };

    let llmDecision: {
      action: "answer" | "navigate" | "extract" | "done";
      reasoning: string;
      answer?: string;
      target_url?: string;
      extracted_data?: string;
    };

    try {
      const llmRes = await fetch(`${config.PYTHON_LLM_URL}/agent/step/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(llmPayload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!llmRes.ok) {
        const errText = await llmRes.text();
        throw new Error(`LLM returned ${llmRes.status}: ${errText}`);
      }

      llmDecision = (await llmRes.json()) as typeof llmDecision;
    } catch (err: any) {
      log.warn("Agent LLM step failed", { step: stepNum, error: err.message });
      steps.push({
        step: stepNum,
        url: currentUrl,
        action: "llm_error",
        reasoning: `LLM call failed: ${err.message}`,
      });
      break;
    }

    log.debug("Agent step", {
      step: stepNum,
      action: llmDecision.action,
      reasoning: llmDecision.reasoning.slice(0, 100),
    });

    // 3. Execute the LLM's decision
    const step: AgentStep = {
      step: stepNum,
      url: currentUrl,
      action: llmDecision.action,
      reasoning: llmDecision.reasoning,
    };

    switch (llmDecision.action) {
      case "answer":
      case "done":
        finalAnswer = llmDecision.answer ?? llmDecision.extracted_data ?? "No answer provided";
        step.result = finalAnswer;
        steps.push(step);
        break;

      case "navigate":
        if (llmDecision.target_url && allowNavigation && pagesVisited.length < maxPages) {
          step.result = `Navigating to: ${llmDecision.target_url}`;
          steps.push(step);
          currentUrl = llmDecision.target_url;
        } else {
          step.result = "Navigation blocked (limit reached or disabled)";
          steps.push(step);
        }
        continue;

      case "extract":
        step.result = llmDecision.extracted_data;
        steps.push(step);
        continue;

      default:
        step.result = "Unknown action";
        steps.push(step);
        break;
    }

    // If we got an answer, stop
    if (finalAnswer) break;
  }

  // If no final answer after all steps, synthesize one
  if (!finalAnswer) {
    finalAnswer = steps
      .filter((s) => s.result)
      .map((s) => s.result)
      .join("\n\n") || "Agent could not determine an answer within the step limit.";
  }

  await job.updateProgress(100);
  log.info("Agent completed", {
    url,
    totalSteps: steps.length,
    pagesVisited: pagesVisited.length,
    ms: Date.now() - start,
  });

  return {
    success: true,
    data: {
      url,
      answer: finalAnswer,
      steps,
      pages_visited: pagesVisited,
      total_steps: steps.length,
    },
    processing_time_ms: Date.now() - start,
  };
}
