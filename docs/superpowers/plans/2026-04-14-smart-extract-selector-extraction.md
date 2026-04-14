# Smart Extract — Selector-Based Structured Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LLM-based markdown extraction (Phase D, token-limited) with a heuristic sampler + LLM selector generation + cheerio DOM extraction that scales to any number of records.

**Architecture:** Phase C (navigation) closes the browser and returns raw HTML. New Phase C2 finds 3 repeating elements heuristically, sends a tiny sample to the LLM for CSS selector generation, and Phase C3 uses cheerio to run those selectors against the full captured HTML — no LLM sees the actual data.

**Tech Stack:** TypeScript, cheerio ^1.0.0, undici fetch, vitest, existing `/plan/` Python LLM endpoint.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/engine/structure-analyzer.ts` | **CREATE** | Heuristic sampler + LLM selector analysis + cheerio extraction |
| `src/__tests__/structure-analyzer.test.ts` | **CREATE** | Unit tests for all three functions |
| `src/engine/guided-executor.ts` | **MODIFY** | Rename to `executeNavigation`, remove `_schema`, expose `html` in result |
| `src/jobs/smart-extract.ts` | **MODIFY** | Remove Phase D, add C2+C3, add `structuring` progress phase |

---

## Task 1: Create structure-analyzer.ts — heuristic sampler

**Files:**
- Create: `src/engine/structure-analyzer.ts`
- Create: `src/__tests__/structure-analyzer.test.ts`

- [ ] **Step 1: Write the failing tests for sampleRepeatingElements**

Create `src/__tests__/structure-analyzer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sampleRepeatingElements } from "../engine/structure-analyzer.js";

describe("sampleRepeatingElements", () => {
  it("returns a sample when <tr> elements repeat >= 3 times", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td><td>Maceio</td></tr>
      <tr><td>BA</td><td>Club 2</td><td>Salvador</td></tr>
      <tr><td>CE</td><td>Club 3</td><td>Fortaleza</td></tr>
    </tbody></table>`;
    const sample = sampleRepeatingElements(html);
    expect(sample).not.toBeNull();
    expect(sample).toContain("Club 1");
    expect(sample).toContain("Club 2");
  });

  it("returns a sample when <li> elements repeat >= 3 times", () => {
    const html = `<ul>
      <li class="item">Item 1</li>
      <li class="item">Item 2</li>
      <li class="item">Item 3</li>
    </ul>`;
    const sample = sampleRepeatingElements(html);
    expect(sample).not.toBeNull();
    expect(sample).toContain("Item 1");
  });

  it("returns null when no element appears >= 3 times", () => {
    const html = `<div><p>One</p><p>Two</p></div>`;
    expect(sampleRepeatingElements(html)).toBeNull();
  });

  it("caps output at 3000 chars", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      `<tr><td>UF${i}</td><td>Club ${i}</td><td>City ${i}</td></tr>`
    ).join("\n");
    const html = `<table><tbody>${rows}</tbody></table>`;
    const sample = sampleRepeatingElements(html);
    expect(sample).not.toBeNull();
    expect(sample!.length).toBeLessThanOrEqual(3000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx vitest run src/__tests__/structure-analyzer.test.ts 2>&1
```

Expected: FAIL — `Cannot find module '../engine/structure-analyzer.js'`

- [ ] **Step 3: Create structure-analyzer.ts with sampleRepeatingElements**

Create `src/engine/structure-analyzer.ts`:

```typescript
// src/engine/structure-analyzer.ts
import { load } from "cheerio";
import { fetch } from "undici";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const CANDIDATE_TAGS = ["tr", "li", "article", "div", "section"] as const;
const MIN_OCCURRENCES = 3;
const MAX_SAMPLE_CHARS = 3000;

/**
 * Phase C2 — Part 1: Heuristic sampler.
 *
 * Finds the most frequently repeating element in the HTML (e.g. <tr>, <li>)
 * and returns the first 3 occurrences inside their parent as a compact HTML
 * fragment. The fragment is capped at MAX_SAMPLE_CHARS so the LLM input stays
 * small regardless of how many total records the page contains.
 *
 * Returns null if no element repeats >= MIN_OCCURRENCES times.
 */
export function sampleRepeatingElements(html: string): string | null {
  const $ = load(html);
  const freq = new Map<string, number>();

  for (const tag of CANDIDATE_TAGS) {
    $(tag).each((_, el) => {
      const cls = ($(el).attr("class") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join(".");
      const key = cls ? `${tag}.${cls}` : tag;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    });
  }

  let bestKey = "";
  let bestCount = 0;
  for (const [key, count] of freq) {
    if (count >= MIN_OCCURRENCES && count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }

  if (!bestKey) return null;

  const firstMatch = $(bestKey).first();
  if (!firstMatch.length) return null;

  const parentHtml = $.html(firstMatch.parent()) ?? "";
  return parentHtml.slice(0, MAX_SAMPLE_CHARS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx vitest run src/__tests__/structure-analyzer.test.ts 2>&1
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
git add src/engine/structure-analyzer.ts src/__tests__/structure-analyzer.test.ts
git commit -m "feat(structure-analyzer): heuristic repeating-element sampler with tests"
```

---

## Task 2: Add analyzeStructure() to structure-analyzer.ts

**Files:**
- Modify: `src/engine/structure-analyzer.ts`
- Modify: `src/__tests__/structure-analyzer.test.ts`

- [ ] **Step 1: Add tests for analyzeStructure**

Append to `src/__tests__/structure-analyzer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { analyzeStructure } from "../engine/structure-analyzer.js";

// Mock undici fetch so tests don't make real HTTP calls
vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

import { fetch } from "undici";

describe("analyzeStructure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no repeating elements found", async () => {
    const html = `<div><p>One</p><p>Two</p></div>`;
    const result = await analyzeStructure(html, { clube: "string", uf: "string" }, "extract clubs");
    expect(result).toBeNull();
  });

  it("returns PageStructure on successful LLM response", async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: JSON.stringify({
          container: "tbody tr",
          fields: { uf: "td:nth-child(1)", clube: "td:nth-child(2)" },
          confidence: "high",
        }),
      }),
    });

    const html = `<table><tbody>
      <tr><td>AL</td><td>Club 1</td></tr>
      <tr><td>BA</td><td>Club 2</td></tr>
      <tr><td>CE</td><td>Club 3</td></tr>
    </tbody></table>`;

    const result = await analyzeStructure(html, { uf: "string", clube: "string" }, "extract clubs");
    expect(result).not.toBeNull();
    expect(result!.container).toBe("tbody tr");
    expect(result!.fields.uf).toBe("td:nth-child(1)");
    expect(result!.confidence).toBe("high");
  });

  it("returns null when LLM call fails", async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const html = `<table><tbody>
      <tr><td>A</td></tr><tr><td>B</td></tr><tr><td>C</td></tr>
    </tbody></table>`;

    const result = await analyzeStructure(html, { field: "string" }, "extract");
    expect(result).toBeNull();
  });

  it("returns null when confidence is low", async () => {
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: JSON.stringify({
          container: "div",
          fields: { field: null },
          confidence: "low",
        }),
      }),
    });

    const html = `<table><tbody>
      <tr><td>A</td></tr><tr><td>B</td></tr><tr><td>C</td></tr>
    </tbody></table>`;

    const result = await analyzeStructure(html, { field: "string" }, "extract");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx vitest run src/__tests__/structure-analyzer.test.ts 2>&1
```

Expected: FAIL — `analyzeStructure is not a function`

- [ ] **Step 3: Add PageStructure interface and analyzeStructure() to structure-analyzer.ts**

Append to `src/engine/structure-analyzer.ts` (after the `sampleRepeatingElements` function):

```typescript
const STRUCTURE_SYSTEM_PROMPT = `You are a DOM structure analyzer. Given an HTML fragment and a data schema, identify the minimal CSS selectors needed to extract each field from every repeating record.

Return ONLY a JSON object with this exact shape:
{
  "container": "<CSS selector matching ONE record relative to document>",
  "fields": {
    "<field_name>": "<CSS selector relative to the container element>"
  },
  "confidence": "high" | "medium" | "low"
}

Rules:
- container: selects the repeating element (one per record)
- fields: each selector is relative to a single container element
- Prefer tag+nth-child or tag+class selectors over brittle id-based ones
- If a field cannot be mapped, set its selector to null
- Return ONLY the JSON object, no markdown fences, no explanation`;

export interface PageStructure {
  container: string;
  fields: Record<string, string | null>;
  confidence: "high" | "medium" | "low";
}

/**
 * Phase C2 — Part 2: LLM structure analysis.
 *
 * Sends a compact HTML sample (from sampleRepeatingElements) to the Python
 * LLM /plan/ endpoint with a structure-analysis system prompt. The LLM
 * returns CSS selectors — never the actual data. Token output is tiny.
 *
 * Returns null on any failure so the job degrades gracefully to raw markdown.
 */
export async function analyzeStructure(
  html: string,
  schema: Record<string, string>,
  goal: string,
): Promise<PageStructure | null> {
  const sample = sampleRepeatingElements(html);
  if (!sample) {
    logger.warn("structure-analyzer: no repeating elements found, skipping");
    return null;
  }

  const schemaDesc = Object.keys(schema).join(", ");
  const message = [
    `Schema fields to extract: ${schemaDesc}`,
    `Goal: ${goal}`,
    `HTML fragment:\n${sample}`,
  ].join("\n\n");

  try {
    const res = await fetch(`${config.PYTHON_LLM_URL}/plan/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: STRUCTURE_SYSTEM_PROMPT, message }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      logger.warn("structure-analyzer: LLM call failed", { status: res.status });
      return null;
    }

    const body = (await res.json()) as { text?: string };
    const raw = body.text ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("structure-analyzer: LLM returned no JSON");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as PageStructure;

    if (parsed.confidence === "low") {
      logger.warn("structure-analyzer: confidence too low, skipping structured extraction");
      return null;
    }

    logger.info("structure-analyzer: structure analyzed", {
      container: parsed.container,
      fields: Object.keys(parsed.fields),
      confidence: parsed.confidence,
    });

    return parsed;
  } catch (err: any) {
    logger.warn("structure-analyzer: analysis failed", { error: err.message });
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx vitest run src/__tests__/structure-analyzer.test.ts 2>&1
```

Expected: all tests in `analyzeStructure` describe block PASS

- [ ] **Step 5: Commit**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
git add src/engine/structure-analyzer.ts src/__tests__/structure-analyzer.test.ts
git commit -m "feat(structure-analyzer): LLM-based CSS selector analysis with tests"
```

---

## Task 3: Add extractWithSelectors() to structure-analyzer.ts

**Files:**
- Modify: `src/engine/structure-analyzer.ts`
- Modify: `src/__tests__/structure-analyzer.test.ts`

- [ ] **Step 1: Add tests for extractWithSelectors**

Append to `src/__tests__/structure-analyzer.test.ts`:

```typescript
import { extractWithSelectors } from "../engine/structure-analyzer.js";
import type { PageStructure } from "../engine/structure-analyzer.js";

describe("extractWithSelectors", () => {
  const structure: PageStructure = {
    container: "tbody tr",
    fields: {
      uf: "td:nth-child(1)",
      clube: "td:nth-child(2)",
      cidade: "td:nth-child(3)",
    },
    confidence: "high",
  };

  it("extracts all matching records", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>AATA</td><td>Maceio</td></tr>
      <tr><td>BA</td><td>ALEM</td><td>Salvador</td></tr>
      <tr><td>CE</td><td>FCETARCO</td><td>Fortaleza</td></tr>
    </tbody></table>`;

    const records = extractWithSelectors(html, structure);
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ uf: "AL", clube: "AATA", cidade: "Maceio" });
    expect(records[2]).toEqual({ uf: "CE", clube: "FCETARCO", cidade: "Fortaleza" });
  });

  it("handles null selectors gracefully", () => {
    const partialStructure: PageStructure = {
      container: "tbody tr",
      fields: { uf: "td:nth-child(1)", clube: null, cidade: "td:nth-child(3)" },
      confidence: "medium",
    };
    const html = `<table><tbody>
      <tr><td>AL</td><td>AATA</td><td>Maceio</td></tr>
      <tr><td>BA</td><td>ALEM</td><td>Salvador</td></tr>
      <tr><td>CE</td><td>FCETARCO</td><td>Fortaleza</td></tr>
    </tbody></table>`;

    const records = extractWithSelectors(html, partialStructure) as Record<string, string | null>[];
    expect(records).toHaveLength(3);
    expect(records[0].clube).toBeNull();
    expect(records[0].uf).toBe("AL");
  });

  it("filters out records where all fields are empty", () => {
    const html = `<table><tbody>
      <tr><td>AL</td><td>AATA</td><td>Maceio</td></tr>
      <tr></tr>
      <tr><td>CE</td><td>FCETARCO</td><td>Fortaleza</td></tr>
    </tbody></table>`;

    const records = extractWithSelectors(html, structure);
    expect(records).toHaveLength(2);
  });

  it("returns empty array when container selector matches nothing", () => {
    const html = `<div><p>No table here</p></div>`;
    const records = extractWithSelectors(html, structure);
    expect(records).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx vitest run src/__tests__/structure-analyzer.test.ts 2>&1
```

Expected: FAIL — `extractWithSelectors is not a function`

- [ ] **Step 3: Add extractWithSelectors() to structure-analyzer.ts**

Append to `src/engine/structure-analyzer.ts` (after `analyzeStructure`):

```typescript
/**
 * Phase C3: Cheerio-based DOM extraction.
 *
 * Runs the CSS selectors (from analyzeStructure) against the full captured
 * HTML using cheerio. Extracts every matching record directly from the DOM —
 * no LLM involved, no token limits. Scales to any number of records.
 *
 * Records where all fields are empty/null are filtered out.
 */
export function extractWithSelectors(
  html: string,
  structure: PageStructure,
): unknown[] {
  const $ = load(html);
  const records: unknown[] = [];

  $(structure.container).each((_, containerEl) => {
    const record: Record<string, string | null> = {};

    for (const [field, selector] of Object.entries(structure.fields)) {
      if (!selector) {
        record[field] = null;
        continue;
      }
      const text = $(containerEl).find(selector).first().text().trim();
      record[field] = text || null;
    }

    // Skip records where every field is null/empty
    if (Object.values(record).some((v) => v !== null)) {
      records.push(record);
    }
  });

  logger.info("structure-analyzer: extraction complete", { records: records.length });
  return records;
}
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx vitest run src/__tests__/structure-analyzer.test.ts 2>&1
```

Expected: all tests PASS (sampleRepeatingElements × 4, analyzeStructure × 4, extractWithSelectors × 4)

- [ ] **Step 5: TypeScript check**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx tsc --noEmit 2>&1
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
git add src/engine/structure-analyzer.ts src/__tests__/structure-analyzer.test.ts
git commit -m "feat(structure-analyzer): cheerio-based DOM extraction with tests"
```

---

## Task 4: Simplify guided-executor.ts → executeNavigation

**Files:**
- Modify: `src/engine/guided-executor.ts`

The executor currently returns `ExecutionResult` which has no `html` field. We need to expose `firstResult.html` so Phase C2+C3 in `smart-extract.ts` can run against the rendered page. We also remove the `_schema` parameter (schema concerns move to `structure-analyzer.ts`).

- [ ] **Step 1: Replace guided-executor.ts**

Replace the entire content of `src/engine/guided-executor.ts` with:

```typescript
// MarkUDown-Engine/src/engine/guided-executor.ts
import { extract } from "./orchestrator.js";
import { playwrightFetch } from "./playwright-engine.js";
import { cleanHtml } from "../processors/html-cleaner.js";
import { convertToMarkdown } from "../processors/markdown-client.js";
import { logger } from "../utils/logger.js";
import type { Difficulty } from "./site-analyzer.js";
import type { ExtractionPlan } from "./extraction-planner.js";

export interface NavigationResult {
  /** Full rendered HTML of the first page after all actions + scrollToBottom. */
  html: string;
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

function layerLabel(difficulty: Difficulty): NavigationResult["layerUsed"] {
  if (difficulty === "hard") return "abrasio-cloud";
  if (difficulty === "medium") return "abrasio-local";
  return "patchright";
}

/**
 * Phase C: Execute the navigation action plan and capture page content.
 *
 * Runs all LLM-planned actions (clicks, selects, waits) plus an automatic
 * scrollToBottom to ensure lazy-loaded content is fully rendered. Returns
 * both the raw HTML snapshot (for Phase C2/C3 selector extraction) and
 * the converted markdown (for markdown-format responses or fallback).
 */
export async function executeNavigation(
  url: string,
  plan: ExtractionPlan,
  difficulty: Difficulty,
  timeout: number,
): Promise<NavigationResult> {
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

  // Append scrollToBottom after the action plan so lazy-loaded lists and
  // AJAX tables are fully rendered before the HTML is captured.
  const allActions: typeof plan.actions = [
    ...plan.actions,
    { type: "scrollToBottom", waitMs: 1500, maxAttempts: 10 },
  ];

  // Execute the action plan on the first page via Patchright
  const firstResult = await playwrightFetch(url, {
    timeout,
    actions: allActions,
    skipResourceBlocking: allActions.length > 0,
  });

  // Capture the first page's HTML — this is what C2/C3 will analyse.
  // After scrollToBottom, all dynamically-loaded records are present.
  const firstPageHtml = firstResult.html;

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
    html: firstPageHtml,
    markdown: allMarkdown,
    pagesTraversed,
    recordsExtracted,
    layerUsed: layerLabel(difficulty),
  };
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx tsc --noEmit 2>&1
```

Expected: errors in `smart-extract.ts` only (it still imports `executeExtraction` which no longer exists) — that is expected and will be fixed in Task 5.

- [ ] **Step 3: Commit**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
git add src/engine/guided-executor.ts
git commit -m "refactor(guided-executor): rename to executeNavigation, expose html in result, remove schema param"
```

---

## Task 5: Wire up smart-extract.ts — remove Phase D, add C2+C3

**Files:**
- Modify: `src/jobs/smart-extract.ts`

- [ ] **Step 1: Replace smart-extract.ts**

Replace the entire content of `src/jobs/smart-extract.ts` with:

```typescript
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
 * Smart Extract job: 5-phase selector-based extraction.
 *
 * Phase A — site analysis (difficulty, interactive elements)
 * Phase B — LLM-based navigation planning (actions to reach the data)
 * Phase C — Playwright executes actions + scrollToBottom → HTML snapshot
 * Phase C2 — Heuristic sampler + LLM generates CSS selectors from tiny sample
 * Phase C3 — Cheerio runs selectors against full HTML → records[] (no token limit)
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

  // Phase B: Plan navigation
  await job.updateProgress({ phase: "planning", pct: 35 });
  const plan = await planExtraction(goal, hints, siteMap, max_pages);

  // Phase C: Execute navigation + capture HTML snapshot
  await job.updateProgress({ phase: "executing", pct: 60 });
  const navResult = await executeNavigation(url, plan, siteMap.difficulty, timeout);

  // Phase C2 + C3: Selector analysis + cheerio extraction
  // Only runs when output_format is "json" and a schema is provided.
  // Falls back silently to raw markdown if any step fails.
  let jsonData: unknown[] | undefined;
  if (output_format === "json" && schema && Object.keys(schema).length > 0) {
    await job.updateProgress({ phase: "structuring", pct: 80 });
    log.info("Smart extract: analyzing page structure (Phase C2)");

    const structure = await analyzeStructure(navResult.html, schema, goal);
    if (structure) {
      log.info("Smart extract: extracting with selectors (Phase C3)", {
        container: structure.container,
      });
      const records = extractWithSelectors(navResult.html, structure);
      if (records.length > 0) {
        jsonData = records;
        log.info("Smart extract: selector extraction complete", { records: records.length });
      } else {
        log.warn("Smart extract: selectors matched 0 records, falling back to markdown");
      }
    } else {
      log.warn("Smart extract: structure analysis failed, falling back to markdown");
    }
  }

  const durationMs = Date.now() - start;
  await job.updateProgress({ phase: "done", pct: 100 });

  const recordCount = jsonData ? jsonData.length : navResult.recordsExtracted;

  log.info("Smart extract completed", {
    url,
    layer: navResult.layerUsed,
    pages: navResult.pagesTraversed,
    records: recordCount,
    ms: durationMs,
  });

  return {
    success: true,
    data: {
      url,
      markdown: navResult.markdown,
      ...(jsonData !== undefined && { json_data: jsonData }),
      metadata: {
        layer_used: navResult.layerUsed,
        pages_traversed: navResult.pagesTraversed,
        records_extracted: recordCount,
        difficulty: siteMap.difficulty,
        actions_executed: plan.actions.length,
        planner_reasoning: plan.reasoning,
        duration_ms: durationMs,
      },
    },
    processing_time_ms: durationMs,
  };
}
```

- [ ] **Step 2: TypeScript check — must be clean**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx tsc --noEmit 2>&1
```

Expected: no errors

- [ ] **Step 3: Run all tests**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
npx vitest run 2>&1
```

Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/MarkUDown-Engine"
git add src/jobs/smart-extract.ts
git commit -m "feat(smart-extract): replace Phase D with selector-based C2+C3 extraction

LLM now only sees a tiny HTML sample to generate CSS selectors (Phase C2).
Cheerio extracts all records directly from DOM using those selectors (Phase C3).
Removes token output bottleneck — scales to any number of records."
```

---

## Task 6: Update Playground.js stepper for new progress phases

**Files:**
- Modify: `st-data-store/components/Playground.js`

The backend now emits `structuring` instead of `validating`. The frontend stepper needs to reflect this.

- [ ] **Step 1: Find the stepper JSX in Playground.js**

Search for the phase stepper — it was added during Phase 2 implementation. Find the section that renders the 4 stepper phases for smart-extract (Analisando, Planejando, Executando, Validando).

Run:
```bash
grep -n "Validando\|validating\|stepper\|phase" "c:/Users/jvoso/Documents/Scrape Technology Projects/st-data-store/components/Playground.js" | head -20
```

- [ ] **Step 2: Replace "Validando" with "Estruturando" in the stepper**

In `st-data-store/components/Playground.js`, find the stepper phases array/JSX for smart-extract. Change:

```jsx
// BEFORE — 4 phases: analyzing, planning, executing, validating
{ phase: "validating", label: "Validando" }
```

to:

```jsx
// AFTER — 4 phases: analyzing, planning, executing, structuring
{ phase: "structuring", label: "Estruturando" }
```

Also update the `setSmartExtractPhase` call in `startPolling` — wherever `data.progress.phase === "validating"` is compared, update to `"structuring"`.

- [ ] **Step 3: Check for all occurrences of "validating" in Playground.js**

```bash
grep -n "validating" "c:/Users/jvoso/Documents/Scrape Technology Projects/st-data-store/components/Playground.js"
```

Replace every `"validating"` with `"structuring"` in the smart-extract context (do not change unrelated code).

- [ ] **Step 4: TypeScript / lint check**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/st-data-store"
npm run lint 2>&1 | head -20
```

Expected: no new errors

- [ ] **Step 5: Commit**

```bash
cd "c:/Users/jvoso/Documents/Scrape Technology Projects/st-data-store"
git add components/Playground.js
git commit -m "feat(playground): update smart-extract stepper: validating → structuring"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Phase C2 heuristic sampler → Task 1
- ✅ LLM structure analysis → Task 2
- ✅ Cheerio DOM extraction → Task 3
- ✅ guided-executor simplified, html exposed → Task 4
- ✅ Phase D removed, C2+C3 wired in → Task 5
- ✅ `structuring` progress phase → Task 5 + 6
- ✅ Fallback to markdown on any failure → Task 5 (graceful degradation in all branches)
- ✅ `confidence === "low"` returns null → Task 2

**Placeholder scan:** None found.

**Type consistency:**
- `NavigationResult` defined Task 4, consumed Task 5 ✅
- `PageStructure` defined Task 2, consumed Tasks 3 + 5 ✅
- `executeNavigation` defined Task 4, imported Task 5 ✅
- `analyzeStructure` / `extractWithSelectors` defined Tasks 2+3, imported Task 5 ✅
