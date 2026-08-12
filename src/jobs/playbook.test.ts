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
vi.mock("../config.js", () => ({
  config: { SCRAPETECH_API_URL: "https://internal.example", INTERNAL_SERVICE_KEY: "real-internal-key" },
}));
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
      callback_url: "https://client.example/playbooks/pb1/ingest",
      callback_headers: { "X-Internal-Key": "secret-internal" },
    }));

    expect(mockWebhook).toHaveBeenCalledTimes(1);
    const [webhookConfig] = mockWebhook.mock.calls[0];
    expect(webhookConfig).toMatchObject({
      url: "https://client.example/playbooks/pb1/ingest",
      headers: { "X-Internal-Key": "secret-internal" },
    });
  });

  it("forwards callback_headers to sendWebhook on failure", async () => {
    mockRun.mockResolvedValueOnce({ ok: false, reason: "selector" });
    await processPlaybookJob(makeJob(PLAYBOOK, {}, {
      callback_url: "https://client.example/playbooks/pb1/ingest",
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
      callback_url: "https://client.example/playbooks/pb1/ingest",
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

describe("processPlaybookJob — internal X-Internal-Key attachment (security review, 2026-08-11)", () => {
  // The api no longer puts X-Internal-Key into job data at all (it used to, which
  // persisted a high-privilege credential into Redis on every scheduled monitor tick).
  // The worker now attaches it from its OWN config, but only when callback_url's ORIGIN
  // matches SCRAPETECH_API_URL exactly — never from job data, and never for a URL that
  // merely looks similar.
  it("attaches X-Internal-Key from its own config when callback_url is this api's own origin", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: {} });
    await processPlaybookJob(makeJob(PLAYBOOK, {}, {
      callback_url: "https://internal.example/api/playbooks/pb1/ingest",
      // No callback_headers at all in job data — proves the key isn't sourced from there.
    }));

    const [webhookConfig] = mockWebhook.mock.calls[0];
    expect(webhookConfig.headers).toMatchObject({ "X-Internal-Key": "real-internal-key" });
  });

  it("a prefix/substring trick does NOT count as matching our own origin", async () => {
    // Bug found in automated commit review, 2026-08-11: an early version of this check
    // used callbackUrl.startsWith(SCRAPETECH_API_URL), which a host like
    // "internal.example.attacker.example" also satisfies as a STRING prefix while being
    // a completely different origin. Real origin comparison must reject this.
    mockRun.mockResolvedValueOnce({ ok: true, data: {} });
    await processPlaybookJob(makeJob(PLAYBOOK, {}, {
      callback_url: "https://internal.example.attacker.example/steal",
    }));

    const [webhookConfig] = mockWebhook.mock.calls[0];
    expect(webhookConfig.headers?.["X-Internal-Key"]).toBeUndefined();
  });

  it("an unparseable callback_url falls through safely, does not throw or leak the key", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, data: {} });
    await processPlaybookJob(makeJob(PLAYBOOK, {}, { callback_url: "not a url at all" }));

    const [webhookConfig] = mockWebhook.mock.calls[0];
    expect(webhookConfig.headers?.["X-Internal-Key"]).toBeUndefined();
  });
});
