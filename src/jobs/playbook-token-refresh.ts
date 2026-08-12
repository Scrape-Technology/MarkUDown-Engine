/**
 * playbook-token-refresh worker — Milestone 2 (spec 2026-07-10, Component 3 follow-up).
 * Dispatched by the api's `/ingest` route on a dead-token failure (`reason:"token"`),
 * ONLY for playbooks with `refresh_steps` configured (`_maybe_trigger_token_refresh`).
 *
 * NOT a login flow — no credentials, no browser, no persistent-profile pool. Most of
 * these targets are scraped fully anonymously via Abrasio's stealth fingerprinting, but
 * a short-lived session artifact (e.g. a CSRF cookie re-issued on every page load) can
 * still expire even for an anonymous visitor. `refresh_steps` is a small, OWNER-authored
 * HTTP-only request sequence (the same PlaybookStep DSL as the main `steps`, request-ops
 * only) that re-derives a fresh artifact — e.g. "GET the homepage, pull the new cookie
 * out of the response". It is trusted the same as `steps` itself (not LLM-proposed), so
 * none of self-heal's prompt-injection guard rails apply here.
 *
 * Flow:
 *   1. Replay `refresh_steps` via the SAME T0 executor the main playbook uses
 *      (runPlaybook, reusing runHttp/secret-resolution rather than duplicating it).
 *   2. The LAST step's extracted value (its own `response_path`) becomes the new secret.
 *   3. POST it to the api (`/playbooks/{id}/refresh-secret`, X-Internal-Key) — an
 *      in-place update, NOT a new version (a token rotation is mutable runtime state,
 *      unlike self-heal's versioned steps).
 */

import { Job } from "bullmq";
import { fetch } from "undici";
import { runPlaybook, type Playbook, type PlaybookStep } from "../engine/playbook-runner.js";
import { open as openSecrets } from "../engine/secrets-box.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";

export interface PlaybookTokenRefreshJobData {
  playbook_id: string;
  group_id: string;
  domain: string;
  refresh_steps: PlaybookStep[];
  refresh_target_secret: string;
  // Sealed (AES-256-GCM, secrets-box.ts) — opened in-memory below, never re-persisted.
  // See playbook.ts's PlaybookJobData for why this changed from a plaintext map.
  secrets_enc?: string | null;
}

export interface PlaybookTokenRefreshJobResult {
  success: boolean;
  refreshed: boolean;
  reason?: string;
  processing_time_ms: number;
}

/** The refresh worker doesn't send/receive a Playbook shape — it just needs run.data
 *  (whatever `response_path` extracted) coerced into the plain string a secret must be. */
function coerceToSecretValue(data: unknown): string {
  if (typeof data === "string") return data;
  if (data == null) return "";
  if (typeof data === "object") return JSON.stringify(data);
  return String(data);
}

export async function processPlaybookTokenRefreshJob(
  job: Job<PlaybookTokenRefreshJobData>,
): Promise<PlaybookTokenRefreshJobResult> {
  const log = childLogger({ jobId: job.id, queue: "playbook-token-refresh" });
  const start = Date.now();
  const { playbook_id, group_id, domain, refresh_steps, refresh_target_secret, secrets_enc } = job.data;
  const secrets = openSecrets(secrets_enc); // opened in-memory only — never written back to job.data

  if (!refresh_steps || refresh_steps.length === 0) {
    // Shouldn't happen — the api gates dispatch on refresh_steps being present — but
    // fail closed rather than crash if it ever does.
    log.warn("Token refresh: no refresh_steps in job data", { playbook_id });
    return { success: false, refreshed: false, reason: "no_refresh_steps", processing_time_ms: Date.now() - start };
  }

  log.info("Token refresh job started", { playbook_id, group_id, domain });

  await job.updateProgress({ phase: "refreshing", pct: 30 });
  const refreshPlaybook: Playbook = { name: "token-refresh", domain, transport: "http", steps: refresh_steps };
  const run = await runPlaybook(refreshPlaybook, secrets);
  if (!run.ok) {
    log.warn("Token refresh: refresh_steps failed", { playbook_id, reason: run.reason });
    return {
      success: false,
      refreshed: false,
      reason: run.reason ?? "refresh_failed",
      processing_time_ms: Date.now() - start,
    };
  }

  const newValue = coerceToSecretValue(run.data);
  if (!newValue) {
    log.warn("Token refresh: refresh_steps succeeded but extracted an empty value", { playbook_id });
    return { success: false, refreshed: false, reason: "empty_value", processing_time_ms: Date.now() - start };
  }

  await job.updateProgress({ phase: "persisting", pct: 80 });
  try {
    const res = await fetch(`${config.SCRAPETECH_API_URL}/api/playbooks/${playbook_id}/refresh-secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": config.INTERNAL_SERVICE_KEY },
      body: JSON.stringify({ value: newValue }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      log.error("Token refresh: failed to persist new secret", { playbook_id, status: res.status, body: text });
      return { success: false, refreshed: false, reason: "persist_failed", processing_time_ms: Date.now() - start };
    }
  } catch (err) {
    log.error("Token refresh: error persisting new secret", { playbook_id, error: (err as Error).message });
    return { success: false, refreshed: false, reason: "persist_failed", processing_time_ms: Date.now() - start };
  }

  await job.updateProgress({ phase: "done", pct: 100 });
  log.info("Token refresh succeeded", { playbook_id, group_id, refresh_target_secret, ms: Date.now() - start });
  return { success: true, refreshed: true, processing_time_ms: Date.now() - start };
}
