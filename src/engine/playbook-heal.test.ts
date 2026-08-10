import { describe, it, expect, vi, beforeEach } from "vitest";

// proposeHeal() talks to python-llm's generic /plan/ completion endpoint via llmFetch —
// the SAME primitive extraction-planner.ts already uses in production. No new LLM route,
// no external MCP agent process (deliberately simpler than the spec's original DECISION 1).
vi.mock("../utils/llm-fetch.js", () => ({ llmFetch: vi.fn() }));

import { llmFetch } from "../utils/llm-fetch.js";
import { proposeHeal } from "./playbook-heal.js";
import type { Playbook } from "./playbook-runner.js";

const mockLlmFetch = llmFetch as unknown as ReturnType<typeof vi.fn>;

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const PLAYBOOK: Playbook = {
  name: "book-odds",
  domain: "book.example",
  transport: "http_render",
  steps: [
    { op: "navigate", url: "https://book.example/odds" },
    { op: "extract", selector: ".odds-value" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proposeHeal", () => {
  it("calls python-llm's /plan/ (not a new/dedicated heal route) with system+message", async () => {
    mockLlmFetch.mockResolvedValueOnce(
      jsonRes(200, { text: JSON.stringify({ steps: PLAYBOOK.steps, reasoning: "no change needed" }) }),
    );

    await proposeHeal({
      playbook: PLAYBOOK,
      brokeAtIndex: 1,
      brokeStep: PLAYBOOK.steps[1],
      reason: "response_shape",
      pageState: "<html><body><div class='new-odds'>2.10</div></body></html>",
    });

    expect(mockLlmFetch).toHaveBeenCalledTimes(1);
    const [path, body] = mockLlmFetch.mock.calls[0];
    expect(path).toBe("/plan/");
    expect(body).toHaveProperty("system");
    expect(body).toHaveProperty("message");
    expect((body as { message: string }).message).toContain("book.example");
    expect((body as { message: string }).message).toContain("new-odds");
  });

  it("parses a valid JSON proposal out of the LLM's raw text", async () => {
    const proposedSteps = [
      { op: "navigate", url: "https://book.example/odds" },
      { op: "extract", selector: ".new-odds" },
    ];
    mockLlmFetch.mockResolvedValueOnce(
      jsonRes(200, { text: `\`\`\`json\n${JSON.stringify({ steps: proposedSteps, reasoning: "class renamed" })}\n\`\`\`` }),
    );

    const result = await proposeHeal({ playbook: PLAYBOOK, reason: "response_shape", pageState: "<html></html>" });

    expect(result).not.toBeNull();
    expect(result?.steps).toEqual(proposedSteps);
    expect(result?.reasoning).toBe("class renamed");
  });

  it("returns null (never throws) on a non-2xx response", async () => {
    mockLlmFetch.mockResolvedValueOnce(jsonRes(500, { detail: "boom" }));
    const result = await proposeHeal({ playbook: PLAYBOOK, reason: "response_shape", pageState: "<html></html>" });
    expect(result).toBeNull();
  });

  it("returns null when the LLM's text has no parseable JSON object", async () => {
    mockLlmFetch.mockResolvedValueOnce(jsonRes(200, { text: "I cannot help with that." }));
    const result = await proposeHeal({ playbook: PLAYBOOK, reason: "response_shape", pageState: "<html></html>" });
    expect(result).toBeNull();
  });

  it("returns null when the proposal has no non-empty steps array", async () => {
    mockLlmFetch.mockResolvedValueOnce(jsonRes(200, { text: JSON.stringify({ steps: [], reasoning: "nothing found" }) }));
    const result = await proposeHeal({ playbook: PLAYBOOK, reason: "response_shape", pageState: "<html></html>" });
    expect(result).toBeNull();
  });

  it("returns null (not throws) when llmFetch itself rejects", async () => {
    mockLlmFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await proposeHeal({ playbook: PLAYBOOK, reason: "response_shape", pageState: "<html></html>" });
    expect(result).toBeNull();
  });

  it("truncates an oversized pageState rather than sending it unbounded to the LLM", async () => {
    mockLlmFetch.mockResolvedValueOnce(jsonRes(200, { text: JSON.stringify({ steps: PLAYBOOK.steps }) }));
    const huge = "x".repeat(100_000);
    await proposeHeal({ playbook: PLAYBOOK, reason: "response_shape", pageState: huge });

    const [, body] = mockLlmFetch.mock.calls[0];
    const message = (body as { message: string }).message;
    // 60_000-char cap plus the surrounding prompt text — well under the full 100k input.
    expect(message.length).toBeLessThan(huge.length);
  });
});
