// MarkUDown-Engine/src/engine/site-analyzer.ts
import { playwrightFetch } from "./playwright-engine.js";
import { logger } from "../utils/logger.js";

export type Difficulty = "easy" | "medium" | "hard";

export interface InteractiveElement {
  type: "button" | "select" | "input" | "link" | "pagination";
  selector: string;
  label: string;
}

export interface SiteMap {
  url: string;
  title: string;
  difficulty: Difficulty;
  interactiveElements: InteractiveElement[];
  hasPagination: boolean;
  hasLazyLoad: boolean;
  screenshot?: string;
}

const ANTIBOT_MARKERS = [
  "cf-challenge", "hcaptcha", "recaptcha", "challenge-platform",
  "just a moment", "access denied", "__ddg", "datadome",
];

/**
 * Phase A: Visit a URL, extract interactive elements, and estimate anti-bot difficulty.
 * Uses Patchright (Layer 2) for analysis.
 */
export async function analyzeSite(url: string, timeout: number): Promise<SiteMap> {
  logger.info("site-analyzer: starting", { url });

  const result = await playwrightFetch(url, {
    timeout,
    waitUntil: "networkidle",
    actions: [
      { type: "scroll", direction: "down", amount: 500 },
      { type: "wait", milliseconds: 500 },
      { type: "screenshot" },
    ],
  });

  const html = result.html.toLowerCase();
  const screenshot = result.actionScreenshots?.[0] ?? undefined;

  const isHardBlocked = ANTIBOT_MARKERS.some((m) => html.includes(m));
  const difficulty: Difficulty = isHardBlocked
    ? "hard"
    : html.includes("cloudflare") || html.includes("__cf_")
    ? "medium"
    : "easy";

  const titleMatch = result.html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  const hasPagination =
    /rel=["']next["']/i.test(result.html) ||
    /[?&](?:page|pg|p)=\d+/i.test(result.html) ||
    /class=["'][^"']*paginat[^"']*["']/i.test(result.html);

  const hasLazyLoad =
    /data-src=/i.test(result.html) ||
    /loading=["']lazy["']/i.test(result.html) ||
    /IntersectionObserver/i.test(result.html);

  const interactiveElements: InteractiveElement[] = [];

  const buttonMatches = result.html.matchAll(
    /<button[^>]*(?:id=["']([^"']*)["']|class=["']([^"']*)["'])?[^>]*>\s*([^<]{2,40})\s*<\/button>/gi,
  );
  for (const m of buttonMatches) {
    const label = (m[3] || "").trim();
    if (!label || label.length > 40) continue;
    const idAttr = m[1] ? `#${m[1]}` : "";
    const classAttr = m[2] ? `.${m[2].split(" ")[0]}` : "";
    const selector = idAttr || classAttr || "button";
    interactiveElements.push({ type: "button", selector, label });
    if (interactiveElements.filter((e) => e.type === "button").length >= 8) break;
  }

  const selectMatches = result.html.matchAll(
    /<select[^>]*(?:id=["']([^"']*)["']|name=["']([^"']*)["'])?[^>]*>/gi,
  );
  for (const m of selectMatches) {
    const id = m[1] || m[2] || "";
    const selector = id ? (m[1] ? `#${id}` : `[name="${id}"]`) : "select";
    interactiveElements.push({ type: "select", selector, label: id || "select" });
    if (interactiveElements.filter((e) => e.type === "select").length >= 4) break;
  }

  if (hasPagination) {
    interactiveElements.push({
      type: "pagination",
      selector: '[rel="next"], a.next, .pagination a',
      label: "next page",
    });
  }

  logger.info("site-analyzer: done", {
    url,
    difficulty,
    elements: interactiveElements.length,
    hasPagination,
  });

  return {
    url,
    title,
    difficulty,
    interactiveElements,
    hasPagination,
    hasLazyLoad,
    screenshot,
  };
}
