import { fetch } from "undici";
import { config } from "../config.js";

/**
 * Wraps fetch for calls to the python-llm internal service.
 * Automatically injects the X-Internal-Key authentication header.
 */
export function llmFetch(
  path: string,
  body: unknown,
  timeoutMs = 120_000,
): ReturnType<typeof fetch> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.INTERNAL_SERVICE_KEY) {
    headers["X-Internal-Key"] = config.INTERNAL_SERVICE_KEY;
  }
  return fetch(`${config.PYTHON_LLM_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
