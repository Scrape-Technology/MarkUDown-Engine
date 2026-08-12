/**
 * playbook-heal — Milestone 2 (spec 2026-07-10, Component 3). Given a broken playbook
 * step and fresh evidence of the page's current state, asks the python-llm service to
 * propose a corrected `steps` array.
 *
 * Deliberately reuses the SAME generic completion endpoint `extraction-planner.ts`
 * already calls (`POST /plan/` — `{system, message} -> {text}`) rather than adding a new
 * python-llm route or spawning an external MCP agent process (the spec's original
 * DECISION 1): a playbook step DSL is small and fully known here, so a single
 * system-prompted completion is enough to re-derive one broken step. The caller
 * (jobs/playbook-heal.ts) is responsible for verifying the proposal actually works
 * (replaying it for real) before it is ever persisted — this module only proposes.
 */

import { llmFetch } from "../utils/llm-fetch.js";
import { childLogger } from "../utils/logger.js";
import type { Playbook, PlaybookStep } from "./playbook-runner.js";

export interface HealInput {
  playbook: Playbook;
  brokeAtIndex?: number;
  brokeStep?: PlaybookStep;
  reason?: string;
  /** Fresh HTML (T1/T2) or raw response body (T0) captured at/near the break, truncated
   *  by the caller. This is the evidence the LLM reasons from — replay itself never sees
   *  this; only RECORD and SELF-HEAL are allowed to look at live page content. */
  pageState: string;
}

export interface HealProposal {
  steps: PlaybookStep[];
  reasoning: string;
}

const MAX_PAGE_STATE_CHARS = 60_000;

const HEAL_SYSTEM_PROMPT = `You are a web scraping playbook repair engine. A previously-recorded, deterministic
playbook has stopped working because the target site changed. You are given the full
step list, which ONE step broke and why, and fresh evidence of the page's current state.
Propose a corrected step list that fixes the break.

Each step is a JSON object with this shape:
{
  "op": "navigate|click|fill|type|press|scroll|hover|wait_for|evaluate|extract|request",
  "selector": "<css selector, for click/fill/hover/wait_for/extract>",
  "url": "<url, for navigate/request>",
  "text": "<literal text, for fill/type>",
  "secret_ref": "<name, for fill — resolves to a secret the caller holds; NEVER invent one that wasn't already present>",
  "key": "<key name, for press>",
  "pixels": "<number, for scroll>",
  "script": "<JS, for evaluate>",
  "optional": "<bool — true if the step may legitimately fail without breaking the run>",
  "request": {
    "method": "GET|POST|...", "headers": { }, "body_template": null,
    "response_format": "json (default, omit) | text",
    "response_path": "<JSONPath, when the body is JSON — e.g. '$.markets[*].odds'>",
    "response_pattern": "<regex, ONLY when response_format is 'text' — for a non-JSON body (e.g. pipe/CSV-delimited feeds). Capture group 1 is extracted if present, else the whole match. Keep it short and simple — no nested quantifiers like (a+)+ or (a*)*, they will be rejected as unsafe.>"
  }
}

Rules:
1. Return the FULL steps array, in the SAME order, with the SAME length unless the site
   structurally added/removed a stage the recorded flow needs.
2. Only change what is necessary to fix the reported break — do not rewrite steps that
   were not reported broken.
3. Never fabricate a secret_ref that was not already present in the original steps.
4. Prefer stable selectors (data-*, id, semantic tags/aria) over generated/hashed class
   names (e.g. avoid .sc-abc123, .css-xyz456) — the same site may re-hash classes again.
5. For a 'request' step: look at the fresh evidence. If it's valid JSON, use
   response_path (JSONPath). If it is NOT valid JSON (e.g. pipe-delimited, CSV, a raw
   token embedded in plain text), set response_format:"text" and use response_pattern
   (a simple regex) instead — never invent a response_path against a non-JSON body.
6. Return ONLY a JSON object with this exact shape, no markdown fences, no explanation:
   {"steps": [ /* full corrected step list */ ], "reasoning": "<one sentence>"}`;

function buildUserMessage(input: HealInput): string {
  const { playbook, brokeAtIndex, brokeStep, reason } = input;
  const pageState =
    input.pageState.length > MAX_PAGE_STATE_CHARS
      ? input.pageState.slice(0, MAX_PAGE_STATE_CHARS)
      : input.pageState;

  return [
    `Domain: ${playbook.domain}`,
    `Transport: ${playbook.transport}`,
    `Break reason: ${reason ?? "unknown"}`,
    brokeAtIndex !== undefined ? `Broke at step index: ${brokeAtIndex}` : "",
    brokeStep ? `Broken step: ${JSON.stringify(brokeStep)}` : "",
    `Full recorded steps:\n${JSON.stringify(playbook.steps, null, 2)}`,
    `Fresh page state captured at/near the break (${playbook.transport === "http" ? "raw response body" : "HTML"}, truncated to ${MAX_PAGE_STATE_CHARS} chars):\n${pageState}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Ask python-llm to propose a fix. Returns null (never throws) on any failure — the
 *  caller treats a null proposal the same as "heal attempt failed this round". */
export async function proposeHeal(input: HealInput): Promise<HealProposal | null> {
  const log = childLogger({ engine: "playbook-heal", name: input.playbook.name, domain: input.playbook.domain });

  try {
    const res = await llmFetch("/plan/", { system: HEAL_SYSTEM_PROMPT, message: buildUserMessage(input) }, 60_000);
    if (!res.ok) {
      log.warn("heal: LLM planner returned non-2xx", { status: res.status });
      return null;
    }

    const body = (await res.json()) as { text?: string };
    const raw = body.text ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("heal: LLM response had no JSON object");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { steps?: unknown; reasoning?: string };
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      log.warn("heal: LLM proposal missing a non-empty steps array");
      return null;
    }

    return { steps: parsed.steps as PlaybookStep[], reasoning: parsed.reasoning ?? "" };
  } catch (err) {
    log.warn("heal: proposeHeal failed", { error: (err as Error).message });
    return null;
  }
}
