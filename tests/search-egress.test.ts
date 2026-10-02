import { describe, it, expect, vi, beforeEach } from "vitest";
import { EgressPolicyError } from "../src/utils/egress.js";

// Every engine fetch fails with an egress-policy violation (no proxy configured).
const cheerioFetch = vi.fn();
const extract = vi.fn();
vi.mock("../src/engine/cheerio-engine.js", async (orig) => ({
  ...(await orig<typeof import("../src/engine/cheerio-engine.js")>()),
  cheerioFetch: (...a: unknown[]) => cheerioFetch(...a),
}));
vi.mock("../src/engine/orchestrator.js", () => ({ extract: (...a: unknown[]) => extract(...a) }));

const { processSearchJob } = await import("../src/jobs/search.js");
const job = (engine: string) =>
  ({ id: "t", data: { query: "q", options: { engine, scrape_results: false } }, updateProgress: async () => {} }) as any;

describe("search: EgressPolicyError is never downgraded", () => {
  beforeEach(() => {
    cheerioFetch.mockReset().mockRejectedValue(new EgressPolicyError("no proxy"));
    extract.mockReset().mockRejectedValue(new EgressPolicyError("no proxy"));
  });

  it.each(["auto", "all", "brave"])("engine %s rethrows it", async (engine) => {
    await expect(processSearchJob(job(engine))).rejects.toBeInstanceOf(EgressPolicyError);
  });

  it("an ordinary failure is still reported, not thrown (auto)", async () => {
    cheerioFetch.mockRejectedValue(new Error("socket hang up"));
    extract.mockRejectedValue(new Error("captcha"));
    const r = await processSearchJob(job("auto"));
    expect(r).toMatchObject({ success: false, status: "blocked", total: 0 });
  });

  it("brave retries open a fresh connection", async () => {
    cheerioFetch.mockRejectedValue(new Error("reset"));
    await processSearchJob(job("brave")).catch(() => {});
    expect(cheerioFetch.mock.calls.map((c) => (c[2] as { fresh?: boolean }).fresh)).toEqual([false, true, true]);
  });
});
