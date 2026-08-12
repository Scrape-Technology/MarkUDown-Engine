import { describe, it, expect, vi, beforeEach } from "vitest";

// The worker is fed entirely by the job PAYLOAD (correction C2): the api resolves
// the playbook (steps, transport, secrets) and enqueues it; the worker runs it via
// runPlaybook and RETURNS the structured data as the job result. It does NOT touch
// Postgres and (correction C1) does NOT do token-refresh in M1.

vi.mock("../engine/playbook-runner.js", () => ({ runPlaybook: vi.fn() }));
vi.mock("../utils/webhooks.js", () => ({ sendWebhook: vi.fn(async () => {}) }));
// secrets_enc is normally a real sealed AES-GCM blob (secrets-box.ts) — tests pass a
// plain object standing in for "already opened", so the mock is a passthrough rather
// than exercising real crypto (that's covered by secrets-box's own test suite).
vi.mock("../engine/secrets-box.js", () => ({ open: (x: unknown) => x || {} }));
// Provide queues so we can assert the M1 worker does NOT enqueue token-refresh.
vi.mock("../queues/queues.js", () => ({
  playbookQueue: { add: vi.fn(async () => ({ id: "j" })) },
  playbookHealQueue: { add: vi.fn(async () => ({ id: "h" })) },
  playbookTokenRefreshQueue: { add: vi.fn(async () => ({ id: "r" })) },
}));

import { runPlaybook } from "../engine/playbook-runner.js";
import { sendWebhook } from "../utils/webhooks.js";
import * as queues from "../queues/queues.js";
import { processPlaybookJob } from "./playbook.js";

const mockRun = runPlaybook as unknown as ReturnType<typeof vi.fn>;
const mockWebhook = sendWebhook as unknown as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refreshAdd = (queues as any).playbookTokenRefreshQueue.add as ReturnType<typeof vi.fn>;

function makeJob(playbook: unknown, secrets: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    data: { playbook, secrets_enc: secrets, ...extra },
    updateProgress: vi.fn(async () => {}),
  } as never;
}

const PLAYBOOK = {
  id: "pb1",
  name: "bet365-odds-br",
  domain: "book.example",
  transport: "http",
  steps: [{ op: "request", url: "https://book.example/api/odds" }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processPlaybookJob — runs the payload-resolved playbook (C2)", () => {
  it("passes the payload's resolved playbook + secrets to runPlaybook", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: { odds: [1.5] } });
    await processPlaybookJob(makeJob(PLAYBOOK, { session_token: "TOK" }));

    expect(mockRun).toHaveBeenCalledTimes(1);
    const [pbArg, secretsArg] = mockRun.mock.calls[0];
    expect(pbArg).toMatchObject({ transport: "http", steps: PLAYBOOK.steps });
    expect(secretsArg).toMatchObject({ session_token: "TOK" });
  });

  it("on ok: returns the structured data as the job result", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: { odds: [1.5, 2.0] } });
    const result = await processPlaybookJob(makeJob(PLAYBOOK));

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data ?? result)).toContain("1.5");
    expect(refreshAdd).not.toHaveBeenCalled();
  });
});

describe("processPlaybookJob — failure classification", () => {
  it("reason:'token' → surfaced as NOT broken; no token-refresh in M1 (C1)", async () => {
    mockRun.mockResolvedValueOnce({ ok: false, reason: "token" });
    const result = await processPlaybookJob(makeJob(PLAYBOOK, { session_token: "OLD" }));

    expect(result.success).toBeFalsy();
    expect(result.reason).toBe("token");
    // token failures are recoverable, not a structural break
    expect(result.broken).not.toBe(true);
    // token-refresh is deferred to M2 — must not be enqueued here
    expect(refreshAdd).not.toHaveBeenCalled();
  });

  it("reason:'selector' → surfaced as a break", async () => {
    mockRun.mockResolvedValueOnce({
      ok: false,
      reason: "selector",
      brokeAtIndex: 0,
      brokeStep: { op: "request" },
    });
    const result = await processPlaybookJob(makeJob(PLAYBOOK));

    expect(result.success).toBeFalsy();
    expect(result.reason).toBe("selector");
  });

  it("reason:'response_shape' → surfaced as a break", async () => {
    mockRun.mockResolvedValueOnce({ ok: false, reason: "response_shape" });
    const result = await processPlaybookJob(makeJob(PLAYBOOK));

    expect(result.success).toBeFalsy();
    expect(result.reason).toBe("response_shape");
    expect(refreshAdd).not.toHaveBeenCalled();
  });
});

describe("processPlaybookJob — callback_headers pass-through (item 2)", () => {
  // The api auto-injects callback_headers (X-Internal-Key) when it wires the internal
  // /ingest webhook onto a by-group/monitor-triggered run — the worker must forward
  // them to sendWebhook unchanged, on both success and failure.
  it("forwards callback_headers to sendWebhook on success", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: { odds: [1.5] } });
    await processPlaybookJob(makeJob(PLAYBOOK, {}, {
      callback_url: "https://api.example/playbooks/pb1/ingest",
      callback_headers: { "X-Internal-Key": "secret-internal" },
    }));

    expect(mockWebhook).toHaveBeenCalledTimes(1);
    const [webhookConfig] = mockWebhook.mock.calls[0];
    expect(webhookConfig).toMatchObject({
      url: "https://api.example/playbooks/pb1/ingest",
      headers: { "X-Internal-Key": "secret-internal" },
    });
  });

  it("forwards callback_headers to sendWebhook on failure", async () => {
    mockRun.mockResolvedValueOnce({ ok: false, reason: "selector" });
    await processPlaybookJob(makeJob(PLAYBOOK, {}, {
      callback_url: "https://api.example/playbooks/pb1/ingest",
      callback_headers: { "X-Internal-Key": "secret-internal" },
    }));

    const [webhookConfig] = mockWebhook.mock.calls[0];
    expect(webhookConfig).toMatchObject({ headers: { "X-Internal-Key": "secret-internal" } });
  });

  it("forwards brokeAtIndex/brokeStep on failure — /ingest needs them to dispatch heal", async () => {
    mockRun.mockResolvedValueOnce({
      ok: false,
      reason: "selector",
      brokeAtIndex: 3,
      brokeStep: { op: "click", selector: ".gone" },
    });
    await processPlaybookJob(makeJob(PLAYBOOK, {}, {
      callback_url: "https://api.example/playbooks/pb1/ingest",
      callback_headers: { "X-Internal-Key": "secret-internal" },
    }));

    const [, webhookPayload] = mockWebhook.mock.calls[0];
    expect(webhookPayload).toMatchObject({
      brokeAtIndex: 3,
      brokeStep: { op: "click", selector: ".gone" },
    });
  });

  it("callback_headers is optional — a client's own callback_url still works without it", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: {} });
    await processPlaybookJob(makeJob(PLAYBOOK, {}, { callback_url: "https://client.example/hook" }));

    expect(mockWebhook).toHaveBeenCalledTimes(1);
    const [webhookConfig] = mockWebhook.mock.calls[0];
    expect(webhookConfig.url).toBe("https://client.example/hook");
    expect(webhookConfig.headers).toBeUndefined();
  });
});
