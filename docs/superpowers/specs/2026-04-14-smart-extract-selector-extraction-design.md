# Smart Extract — Selector-Based Structured Extraction Design

## Goal

Replace the current Phase D (sending full markdown to LLM for extraction) with a two-step approach: the LLM analyzes only a tiny HTML sample to generate CSS selectors, then Playwright-rendered HTML is queried locally via cheerio. This removes the token-output bottleneck entirely — 88 records or 8000 records make no difference.

## Architecture

Five clean phases orchestrated by `smart-extract.ts`:

```
Phase A  →  analyzeSite()           site-analyzer.ts      (unchanged)
Phase B  →  planNavigation()        extraction-planner.ts (unchanged)
Phase C  →  executeNavigation()     guided-executor.ts    (simplified — navigation only)
Phase C2 →  analyzeStructure()      structure-analyzer.ts (NEW)
Phase C3 →  extractWithSelectors()  structure-analyzer.ts (NEW)
```

Phase D (send full markdown to LLM) is removed.

## Tech Stack

- **cheerio ^1.0.0** — already in `package.json`, used for heuristic sampling and final DOM extraction
- **Python LLM `/plan/` endpoint** — reused with a new system prompt for structure analysis
- **TypeScript** — all new code in `src/engine/structure-analyzer.ts`

---

## Phase C — executeNavigation (guided-executor.ts, simplified)

**What changes:** Remove schema/output_format concerns. The executor now only:
1. Executes the navigation action plan via Playwright
2. Appends `scrollToBottom` action to ensure lazy content is fully rendered
3. Returns `{ html: string, markdown: string }`

The browser closes after this phase. Schema and output_format are no longer parameters.

**Interface:**
```typescript
export interface NavigationResult {
  html: string;
  markdown: string;
  pagesTraversed: number;
  recordsExtracted: number;
  layerUsed: "patchright" | "abrasio-local" | "abrasio-cloud";
}

export async function executeNavigation(
  url: string,
  plan: ExtractionPlan,
  difficulty: Difficulty,
  timeout: number,
): Promise<NavigationResult>
```

---

## Phase C2 — analyzeStructure (structure-analyzer.ts)

### Heuristic Sampler

Before calling the LLM, find the repeating pattern in the HTML using cheerio — no tokens spent on this step.

**Algorithm:**
1. Load full HTML into cheerio
2. Count occurrences of each tag+class combination at every DOM depth
3. The candidate with the highest count (minimum 3 occurrences) is the repeating element
4. Take the first 3 matching elements plus their closest shared parent container
5. Serialize this fragment to HTML string — typically under 2000 chars

**Candidate tags considered:** `tr`, `li`, `div`, `article`, `section`, `a`, `span` — ranked by frequency.

If no repeating element with ≥ 3 occurrences is found, returns `null` (triggers fallback).

### LLM Call

Sends to `POST /plan/` (reusing existing endpoint) with a structure-analysis system prompt:

**System prompt:**
```
You are a DOM structure analyzer. Given an HTML fragment and a data schema, identify the minimal CSS selectors needed to extract each field from every repeating record.

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
- Return ONLY the JSON, no markdown fences, no explanation
```

**Message sent:** HTML fragment (≤ 3000 chars) + schema fields + original goal.

**Output interface:**
```typescript
export interface PageStructure {
  container: string;
  fields: Record<string, string | null>;
  confidence: "high" | "medium" | "low";
}

export async function analyzeStructure(
  html: string,
  schema: Record<string, string>,
  goal: string,
): Promise<PageStructure | null>
```

Returns `null` if:
- Heuristic sampler finds no repeating elements
- LLM call fails or times out
- LLM returns unparseable JSON
- `confidence === "low"`

---

## Phase C3 — extractWithSelectors (structure-analyzer.ts)

Uses cheerio to run the generated selectors against the **full** captured HTML. No LLM involved.

```typescript
export function extractWithSelectors(
  html: string,
  structure: PageStructure,
): unknown[]
```

**Algorithm:**
1. `const $ = cheerio.load(html)`
2. `$(structure.container)` — selects all container elements
3. For each container, for each field: `$(container).find(fieldSelector).text().trim()`
4. Skips records where all fields are empty/null
5. Returns array of objects keyed by schema field names

**No LLM call. No token limit. Scales to any number of records.**

---

## smart-extract.ts Orchestration

```typescript
// Phase A
const siteMap = await analyzeSite(url, timeout);

// Phase B
const plan = await planNavigation(goal, hints, siteMap, max_pages);

// Phase C
await job.updateProgress({ phase: "executing", pct: 60 });
const navResult = await executeNavigation(url, plan, siteMap.difficulty, timeout);

// Phase C2 + C3 (only when output_format === "json" and schema provided)
let jsonData: unknown[] | undefined;
if (output_format === "json" && schema) {
  await job.updateProgress({ phase: "structuring", pct: 80 });
  const structure = await analyzeStructure(navResult.html, schema, goal);
  if (structure) {
    jsonData = extractWithSelectors(navResult.html, structure);
  }
}

await job.updateProgress({ phase: "done", pct: 100 });
```

Progress phases exposed to the UI: `analyzing → planning → executing → structuring → done`

---

## Fallback Behaviour

| Failure point | Behaviour |
|---|---|
| Heuristic finds no repeating element | `analyzeStructure` returns `null` → job returns raw markdown only |
| LLM call fails / timeout | `analyzeStructure` returns `null` → job returns raw markdown only |
| LLM returns unparseable JSON | Same as above |
| `confidence === "low"` | Same as above |
| Cheerio finds 0 containers | `extractWithSelectors` returns `[]` → job returns raw markdown only |
| Any records have all-null fields | Those records are filtered out |

The job always completes successfully. `json_data` is present in the response only when extraction succeeded.

---

## Files Changed

| File | Change |
|---|---|
| `src/engine/structure-analyzer.ts` | **NEW** — heuristic sampler + analyzeStructure + extractWithSelectors |
| `src/engine/guided-executor.ts` | Simplified — remove schema/output_format, rename to executeNavigation, return NavigationResult |
| `src/jobs/smart-extract.ts` | Orchestrate new phases, add "structuring" progress phase, remove Phase D |
| `src/engine/extraction-planner.ts` | Rename planExtraction → planNavigation (internal clarity only) |

## Files NOT Changed

- `src/engine/site-analyzer.ts` — Phase A untouched
- `src/engine/playwright-engine.ts` — scrollToBottom action added in previous commit, no further changes
- Python LLM service — `/plan/` endpoint reused as-is
