import { fetch } from "undici";
import TurndownService from "turndown";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/**
 * Convert HTML to Markdown via the Go service.
 * Falls back to Turndown (in-process) if the Go service is unavailable.
 */
export async function convertToMarkdown(html: string): Promise<string> {
  // Try Go service first
  try {
    const response = await fetch(`${config.GO_MD_SERVICE_URL}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const data = (await response.json()) as { markdown: string; success: boolean };
      if (data.success) return data.markdown;
    }
  } catch (err: any) {
    logger.debug("Go MD service unavailable, using Turndown fallback", { error: err.message });
  }

  // Fallback: Turndown (in-process)
  return turndown.turndown(html);
}
