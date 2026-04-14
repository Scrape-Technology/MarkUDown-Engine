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
      // Normalize class order (sort) so "a b" and "b a" map to the same key.
      // Strip non-word chars to avoid building broken CSS selectors.
      const cls = ($(el).attr("class") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((c) => c.replace(/[^a-zA-Z0-9_-]/g, ""))
        .filter(Boolean)
        .sort()
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

  const allMatches = $(bestKey);
  if (!allMatches.length) return null;

  // Take only the first 3 matching elements.
  // Serialize them inside their parent container — but if the parent is
  // <html> or <body> (i.e. no meaningful container), wrap siblings directly.
  const firstThree = allMatches.slice(0, 3);
  const parent = allMatches.first().parent();
  const parentTag = (parent.prop("tagName") as string | undefined)?.toLowerCase() ?? "";

  if (!parentTag || parentTag === "html" || parentTag === "body") {
    // No meaningful container — return the 3 elements joined
    const fragment = firstThree
      .map((_, el) => $.html(el))
      .get()
      .join("\n");
    return fragment.slice(0, MAX_SAMPLE_CHARS);
  }

  // Rebuild parent with only the first 3 children to avoid huge output
  const parentClone = parent.clone().empty();
  firstThree.each((_, el) => {
    parentClone.append($(el).clone());
  });

  return ($.html(parentClone) ?? "").slice(0, MAX_SAMPLE_CHARS);
}

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

/**
 * Phase C3 — Local DOM extraction via Cheerio.
 *
 * Takes the full HTML and a PageStructure (container selector + field selectors
 * from analyzeStructure), and extracts actual data by running Cheerio selectors
 * against the full document. No LLM, no token limits.
 *
 * Algorithm:
 * 1. Load HTML with Cheerio
 * 2. Select all container elements via structure.container
 * 3. For each container, for each field:
 *    - If field selector is null → value is null
 *    - Otherwise find().first().text().trim() → if empty, store null
 * 4. Build a record object { [fieldName]: value, ... }
 * 5. Filter out records where ALL fields are null
 * 6. Return array of non-empty records
 */
export function extractWithSelectors(
  html: string,
  structure: PageStructure,
): unknown[] {
  const $ = load(html);
  const records: unknown[] = [];

  const containers = $(structure.container);
  if (!containers.length) {
    return [];
  }

  containers.each((_, containerEl) => {
    const record: Record<string, unknown> = {};
    let hasAnyValue = false;

    for (const [fieldName, fieldSelector] of Object.entries(structure.fields)) {
      if (fieldSelector === null) {
        record[fieldName] = null;
      } else {
        const text = $(containerEl).find(fieldSelector).first().text().trim();
        if (text) {
          record[fieldName] = text;
          hasAnyValue = true;
        } else {
          record[fieldName] = null;
        }
      }
    }

    // Only add record if at least one field has a non-null value
    if (hasAnyValue) {
      records.push(record);
    }
  });

  return records;
}
