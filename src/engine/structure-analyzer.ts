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
