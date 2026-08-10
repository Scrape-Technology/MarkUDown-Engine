import { describe, it, expect, vi, beforeEach } from "vitest";

// processPlaybookTokenRefreshJob: replay refresh_steps via runPlaybook (reusing the T0
// executor, not duplicating it), coerce the extracted value to a string, POST it to
// /playbooks/{id}/refresh-secret. NOT a login flow — no browser, no credentials required
// beyond whatever refresh_steps' secret_ref headers resolve to (same trust level as the
// main playbook's own `steps`).

vi.mock("undici", () => ({ fetch: vi.fn() }));
vi.mock("../engine/playbook-runner.js", () => ({ runPlaybook: vi.fn() }));
vi.mock("../config.js", () => ({
  config: { SCRAPETECH_API_URL: "https://api.example", INTERNAL_SERVICE_KEY: "internal-secret" },
}));

import { fetch } from "undici";
import { runPlaybook } from "../engine/playbook-runner.js";
import { processPlaybookTokenRefreshJob, type PlaybookTokenRefreshJobData } from "./playbook-token-refresh.js";

const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
const mockRun = runPlaybook as unknown as ReturnType<typeof vi.fn>;

function makeJob(data: PlaybookTokenRefreshJobData) {
  return { id: "refresh-1", data, updateProgress: vi.fn(async () => {}) } as never;
}

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const REFRESH_STEPS = [
  {
    op: "request",
    url: "https://book.example/",
    request: { method: "GET", headers: {}, response_path: "$.csrf" },
  },
];

const BASE_DATA: PlaybookTokenRefreshJobData = {
  playbook_id: "pb1",
  group_id: "grp1",
  domain: "book.example",
  refresh_steps: REFRESH_STEPS,
  refresh_target_secret: "session_token",
  secrets: {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processPlaybookTokenRefreshJob", () => {
  it("no refresh_steps in job data -> fails closed without calling runPlaybook", async () => {
    const result = await processPlaybookTokenRefreshJob(makeJob({ ...BASE_DATA, refresh_steps: [] }));

    expect(mockRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, refreshed: false, reason: "no_refresh_steps" });
  });

  it("runs refresh_steps via runPlaybook with transport:'http' and the job's secrets", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: "fresh-csrf-value" });
    mockFetch.mockResolvedValueOnce(jsonRes(200, { success: true }));

    await processPlaybookTokenRefreshJob(makeJob({ ...BASE_DATA, secrets: { other: "x" } }));

    expect(mockRun).toHaveBeenCalledTimes(1);
    const [playbookArg, secretsArg] = mockRun.mock.calls[0];
    expect(playbookArg).toMatchObject({ transport: "http", domain: "book.example", steps: REFRESH_STEPS });
    expect(secretsArg).toEqual({ other: "x" });
  });

  it("refresh_steps run fails -> surfaces the runPlaybook reason, does not POST", async () => {
    mockRun.mockResolvedValueOnce({ ok: false, reason: "response_shape" });

    const result = await processPlaybookTokenRefreshJob(makeJob(BASE_DATA));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, refreshed: false, reason: "response_shape" });
  });

  it("a string extracted value is POSTed as-is to /refresh-secret with X-Internal-Key", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: "NEW-TOKEN-XYZ" });
    mockFetch.mockResolvedValueOnce(jsonRes(200, { success: true }));

    const result = await processPlaybookTokenRefreshJob(makeJob(BASE_DATA));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example/api/playbooks/pb1/refresh-secret");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Internal-Key"]).toBe("internal-secret");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ value: "NEW-TOKEN-XYZ" });
    // The target secret NAME is never sent — the api resolves it server-side from the row.
    expect(body.secret_name).toBeUndefined();
    expect(body.refresh_target_secret).toBeUndefined();

    expect(result).toMatchObject({ success: true, refreshed: true });
  });

  it("a non-string extracted value (object) is JSON-stringified before persisting", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: { access_token: "abc", expires_in: 3600 } });
    mockFetch.mockResolvedValueOnce(jsonRes(200, { success: true }));

    await processPlaybookTokenRefreshJob(makeJob(BASE_DATA));

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.value).toBe(JSON.stringify({ access_token: "abc", expires_in: 3600 }));
  });

  it("an empty extracted value is rejected before persisting anything", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: "" });

    const result = await processPlaybookTokenRefreshJob(makeJob(BASE_DATA));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, refreshed: false, reason: "empty_value" });
  });

  it("a null extracted value is rejected before persisting anything", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: null });

    const result = await processPlaybookTokenRefreshJob(makeJob(BASE_DATA));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, refreshed: false, reason: "empty_value" });
  });

  it("persist call fails (non-2xx) -> refreshed:false, reason:persist_failed", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: "NEW-TOKEN" });
    mockFetch.mockResolvedValueOnce(jsonRes(500, { detail: "db down" }));

    const result = await processPlaybookTokenRefreshJob(makeJob(BASE_DATA));

    expect(result).toMatchObject({ success: false, refreshed: false, reason: "persist_failed" });
  });

  it("persist call throws (network error) -> refreshed:false, reason:persist_failed, does not throw out of the job", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: "NEW-TOKEN" });
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await processPlaybookTokenRefreshJob(makeJob(BASE_DATA));

    expect(result).toMatchObject({ success: false, refreshed: false, reason: "persist_failed" });
  });
});
