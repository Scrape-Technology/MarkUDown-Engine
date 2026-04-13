// MarkUDown-Engine/src/engine/extraction-planner.ts
import { fetch } from "undici";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { SiteMap } from "./site-analyzer.js";
import type { PageAction } from "./playwright-engine.js";

export interface ExtractionPlan {
  actions: PageAction[];
  maxPages: number;
  reasoning: string;
}

const PLANNER_SYSTEM_PROMPT = `You are a web extraction planner. Given a user goal and a site map, generate the minimal sequence of browser actions needed to reach and extract the requested data.

Return a JSON object with this exact shape:
{
  "actions": [ /* list of PageAction objects */ ],
  "maxPages": <integer 1-20>,
  "reasoning": "<one sentence>"
}

PageAction types available:
- { "type": "click", "selector": "<css>" }
- { "type": "select", "selector": "<css>", "value": "<option value>" }
- { "type": "type", "selector": "<css>", "text": "<text to type>" }
- { "type": "scroll", "direction": "down", "amount": 1000 }
- { "type": "wait", "milliseconds": 1000 }
- { "type": "waitForSelector", "selector": "<css>", "timeout": 5000 }
- { "type": "pressKey", "key": "Enter" }

Rules:
- Include a final scroll-to-bottom before any pagination.
- Keep the plan minimal: only include actions that are strictly necessary.
- Use the hints provided by the user when present.
- Do not include an "extract" action.
- If no interaction is needed, return an empty actions array.`;

/**
 * Phase B: Call the Python LLM service to generate an action plan.
 * Falls back to a scroll-only plan if the LLM call fails.
 */
export async function planExtraction(
  goal: string,
  hints: string[],
  siteMap: SiteMap,
  maxPages: number,
): Promise<ExtractionPlan> {
  logger.info("extraction-planner: planning", {
    goal: goal.slice(0, 80),
    difficulty: siteMap.difficulty,
  });

  const userMessage = [
    `Goal: ${goal}`,
    hints.length > 0
      ? `User hints:\n${hints.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "",
    `Site URL: ${siteMap.url}`,
    `Page title: ${siteMap.title}`,
    `Anti-bot difficulty: ${siteMap.difficulty}`,
    `Has pagination: ${siteMap.hasPagination}`,
    `Has lazy load: ${siteMap.hasLazyLoad}`,
    siteMap.interactiveElements.length > 0
      ? `Interactive elements:\n${siteMap.interactiveElements
          .map((e) => `- ${e.type} "${e.label}" (selector: ${e.selector})`)
          .join("\n")}`
      : "No interactive elements detected.",
    `Max pages to traverse: ${maxPages}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const res = await fetch(`${config.PYTHON_LLM_URL}/plan/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system: PLANNER_SYSTEM_PROMPT,
        message: userMessage,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM planner returned ${res.status}: ${text}`);
    }

    const body = (await res.json()) as { text?: string; content?: string };
    const raw = body.text ?? body.content ?? "";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Planner returned no JSON");

    const parsed = JSON.parse(jsonMatch[0]) as ExtractionPlan;
    logger.info("extraction-planner: plan ready", {
      actions: parsed.actions.length,
      maxPages: parsed.maxPages,
    });
    return { ...parsed, maxPages: Math.min(parsed.maxPages ?? maxPages, 20) };
  } catch (err: any) {
    logger.warn("extraction-planner: LLM failed, using fallback plan", {
      error: err.message,
    });
    return {
      actions: [
        { type: "scroll", direction: "down", amount: 2000 },
        { type: "wait", milliseconds: 800 },
        { type: "scroll", direction: "down", amount: 2000 },
      ],
      maxPages: 1,
      reasoning: "LLM unavailable — falling back to scroll-only extraction.",
    };
  }
}
