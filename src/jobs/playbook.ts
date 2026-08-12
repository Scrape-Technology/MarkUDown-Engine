import { Job } from "bullmq";
import { runPlaybook, type Playbook, type RunResult } from "../engine/playbook-runner.js";
import { sendWebhook } from "../utils/webhooks.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";
import { open as openSecrets } from "../engine/secrets-box.js";

/**
 * Bug found in review, 2026-08-11: the api used to pass X-Internal-Key through
 * callback_headers in the job payload, which BullMQ then persists in Redis — on the
 * playbook-monitor's recurring dispatch target specifically, this re-wrote a raw,
 * high-privilege credential into Redis on EVERY scheduled tick, for the monitor's
 * entire multi-month lifetime. The worker already holds the same INTERNAL_SERVICE_KEY
 * in its own environment (POST /versions and /refresh-secret already authenticate this
 * way) — so when the callback target is this api's own endpoint, attach the header from
 * OUR OWN config, never from job data. A genuinely external, user-supplied callback_url
 * never matches this and gets exactly the headers the api actually sent (if any).
 */
function resolveCallbackHeaders(callbackUrl: string, jobHeaders: Record<string, string> | undefined) {
  if (config.SCRAPETECH_API_URL && callbackUrl.startsWith(config.SCRAPETECH_API_URL)) {
    return { ...jobHeaders, "X-Internal-Key": config.INTERNAL_SERVICE_KEY };
  }
  return jobHeaders;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Per spec C2, the api resolves the FULL playbook (steps, transport, schema, secrets
 * opened from `secrets_enc`) before enqueueing — this worker never touches Postgres or
 * the api. It runs the payload it was given and returns the data as the job result.
 */
export interface PlaybookJobData {
  playbook: Playbook;
  // Sealed (AES-256-GCM, secrets-box.ts) — opened in-memory below, never re-persisted.
  // Bug found in review, 2026-08-11: this field used to be a plaintext
  // Record<string,string> that the api put straight into job data, which BullMQ then
  // persists in Redis — every credential a playbook holds accumulated there forever.
  secrets_enc?: string | null;
  callback_url?: string;
  // Set by the api when it auto-injects the internal /ingest webhook (spec 2026-07-15,
  // item 2) — carries X-Internal-Key. A client's own callback_url never needs this.
  callback_headers?: Record<string, string>;
}

export interface PlaybookJobResult {
  success: boolean;
  reason?: "selector" | "token" | "response_shape";
  broken?: boolean;
  data?: unknown;
  brokeAtIndex?: number;
  brokeStep?: unknown;
  processing_time_ms: number;
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export async function processPlaybookJob(job: Job<PlaybookJobData>): Promise<PlaybookJobResult> {
  const log = childLogger({ jobId: job.id, queue: "playbook" });
  const start = Date.now();
  const { playbook, secrets_enc, callback_url, callback_headers } = job.data;
  const secrets = openSecrets(secrets_enc); // opened in-memory only — never written back to job.data

  log.info("Playbook job started", {
    name: playbook?.name,
    domain: playbook?.domain,
    transport: playbook?.transport,
  });

  await job.updateProgress({ phase: "running", pct: 20 });
  const run: RunResult = await runPlaybook(playbook, secrets);
  await job.updateProgress({ phase: "done", pct: 100 });

  if (run.ok) {
    log.info("Playbook run succeeded", { name: playbook?.name, ms: Date.now() - start });
    if (callback_url) {
      await sendWebhook(
        { url: callback_url, headers: resolveCallbackHeaders(callback_url, callback_headers) },
        { event: "completed", queue: "playbook", jobId: String(job.id), data: run.data },
      );
    }
    return { success: true, data: run.data, processing_time_ms: Date.now() - start };
  }

  // Failure classification (spec Component 2 / post-audit correction C1):
  //  - reason:"token" — a dead/expired credential. Recoverable, NOT a structural break.
  //    M1 has no profile pool / token-refresh path (C1 descopes it to M2), so it is
  //    simply surfaced here for the caller to retry after rotating the secret.
  //  - reason:"selector" | "response_shape" — the site changed. A structural break;
  //    self-heal (playbook-heal worker, Milestone 2) will re-derive the broken step.
  //    The api — which owns Postgres (C2) — marks `health=broken` and decides whether
  //    to dispatch the heal worker (routes/playbooks.py's `_maybe_trigger_heal`), using
  //    the brokeAtIndex/brokeStep this job forwards via the /ingest webhook below; this
  //    job only reports the classification, it never talks to playbook-heal directly.
  const broken = run.reason === "selector" || run.reason === "response_shape";
  log.warn("Playbook run failed", {
    name: playbook?.name,
    reason: run.reason,
    broken,
    brokeAtIndex: run.brokeAtIndex,
  });

  if (callback_url) {
    await sendWebhook(
      { url: callback_url, headers: resolveCallbackHeaders(callback_url, callback_headers) },
      {
        event: "failed",
        queue: "playbook",
        jobId: String(job.id),
        error: run.reason,
        brokeAtIndex: run.brokeAtIndex,
        brokeStep: run.brokeStep,
      },
    );
  }

  return {
    success: false,
    reason: run.reason,
    broken,
    brokeAtIndex: run.brokeAtIndex,
    brokeStep: run.brokeStep,
    processing_time_ms: Date.now() - start,
  };
}
