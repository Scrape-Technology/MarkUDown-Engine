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
