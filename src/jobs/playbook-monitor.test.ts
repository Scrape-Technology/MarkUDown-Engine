import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors monitor.ts's self-rescheduling shape (spec 2026-07-15, item 3), but never
// touches Postgres — it only fires an HTTP trigger at the api and reschedules itself.

vi.mock("undici", () => ({ fetch: vi.fn() }));

const mockRedisClient = { get: vi.fn(), quit: vi.fn(async () => {}) };
vi.mock("../utils/redis.js", () => ({ createRedisClient: vi.fn(async () => mockRedisClient) }));

const mockQueueAdd = vi.fn(async () => ({ id: "requeued" }));
vi.mock("bullmq", () => ({
  Queue: vi.fn(function Queue(this: { add: typeof mockQueueAdd }) {
    this.add = mockQueueAdd;
  }),
}));

vi.mock("../queues/connection.js", () => ({ connection: {} }));

vi.mock("../config.js", () => ({
  config: { SCRAPETECH_API_URL: "https://api.example", INTERNAL_SERVICE_KEY: "internal-secret" },
}));

import { fetch } from "undici";
import { processPlaybookMonitorJob } from "./playbook-monitor.js";

const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "sched-1",
    data: {
      subscription_id: "sub-1",
      group_id: "group-1",
      interval_ms: 60_000,
      ...overrides,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisClient.get.mockReset();
});

describe("processPlaybookMonitorJob — kill-switch", () => {
  it("stops (does not trigger or reschedule) when the active flag is gone", async () => {
    mockRedisClient.get.mockResolvedValueOnce(null); // deactivated

    const result = await processPlaybookMonitorJob(makeJob());

    expect(result.triggered).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("processPlaybookMonitorJob — trigger + reschedule", () => {
  it("POSTs to /playbooks/by-group/{group_id}/run authenticated as the internal service — never a stored user api_key", async () => {
    mockRedisClient.get.mockResolvedValue("1"); // active on both checks
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await processPlaybookMonitorJob(makeJob());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example/api/playbooks/by-group/group-1/run");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Internal-Key"]).toBe("internal-secret");
    expect(headers["X-API-KEY"]).toBeUndefined();
    expect(result.triggered).toBe(true);
  });

  it("reschedules itself with the configured delay when still active", async () => {
    mockRedisClient.get.mockResolvedValue("1");
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await processPlaybookMonitorJob(makeJob({ interval_ms: 45_000 }));

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const call = mockQueueAdd.mock.calls[0] as unknown as [string, unknown, { delay: number }];
    expect(call[2]).toMatchObject({ delay: 45_000 });
  });

  it("does NOT reschedule if deactivated between the trigger and the re-check", async () => {
    mockRedisClient.get
      .mockResolvedValueOnce("1")   // initial active check
      .mockResolvedValueOnce(null); // deactivated during the trigger call
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    await processPlaybookMonitorJob(makeJob());

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("a failed trigger (non-2xx) still reschedules — a transient api blip shouldn't kill the monitor", async () => {
    mockRedisClient.get.mockResolvedValue("1");
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await processPlaybookMonitorJob(makeJob());

    expect(result.triggered).toBe(false);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it("a network error on the trigger still reschedules", async () => {
    mockRedisClient.get.mockResolvedValue("1");
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await processPlaybookMonitorJob(makeJob());

    expect(result.triggered).toBe(false);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});
