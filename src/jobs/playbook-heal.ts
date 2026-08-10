/**
 * playbook-heal worker — Milestone 2 (spec 2026-07-10, Component 3). Dispatched by the
 * api's `/ingest` route on a structural break (selector / response_shape), gated by its
 * own guard rails (max attempts per group, per-domain lock — see routes/playbooks.py's
 * `_maybe_trigger_heal`).
 *
 * Per C2 the api resolves the FULL playbook (steps, transport, schema, opened secrets)
 * and hands it here inline — this worker never touches Postgres or secrets_enc. Flow:
 *   1. Gather fresh evidence of the page's current state (transport-specific).
 *   2. Ask the LLM (playbook-heal.ts engine helper -> python-llm's /plan/) to propose a
 *      corrected steps array.
 *   3. Reject the proposal if it fails `validateHealProposal` — off-domain step URLs, a
 *      new/modified `evaluate` (arbitrary JS) step, an out-of-range `scroll` pixel value,
 *      or a catastrophic-backtracking-shaped `response_pattern` regex. The evidence in
 *      step 1 is UNTRUSTED, live content from the target site, so a compromised/
 *      adversarial page could try to prompt-inject the LLM into proposing an unsafe
 *      step. This check runs BEFORE step 4 ever executes the candidate for real.
 *   4. VERIFY the proposal by actually replaying it (runPlaybook) before persisting
 *      anything — an unverified "fix" that still doesn't work would silently re-break
 *      the next scheduled run.
 *   5. On success, post the healed steps to the api as version+1
 *      (POST /playbooks/{id}/versions, X-Internal-Key) — the api owns Postgres.
 */

import { Job } from "bullmq";
import { fetch } from "undici";
import { StealthClient, TLSFingerprintError } from "abrasio-sdk";
import {
  runPlaybook,
  executeBrowserStep,
  isUnsafeResponsePattern,
  type Playbook,
  type PlaybookStep,
} from "../engine/playbook-runner.js";
import { openAbrasioPersistentPage } from "../engine/abrasio-engine.js";
import { parseCookieString } from "./instagram.js";
import { proposeHeal } from "../engine/playbook-heal.js";
import { config } from "../config.js";
import { childLogger } from "../utils/logger.js";

const DEFAULT_TIMEOUT_MS = 60_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlaybookHealJobData {
  playbook_id: string;
  group_id: string;
  playbook: Playbook;
  secrets?: Record<string, string>;
  broke_at_index?: number;
  broke_step?: PlaybookStep;
  reason?: string;
}

export interface PlaybookHealJobResult {
  success: boolean;
  healed: boolean;
  reason?: string;
  processing_time_ms: number;
}

function resolveSecretHeader(raw: string, secrets: Record<string, string>): string | undefined {
  if (!raw.startsWith("secret_ref:")) return raw;
  return secrets[raw.slice("secret_ref:".length)];
}

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_STEP_OPS = new Set([
  "navigate", "click", "fill", "type", "press", "scroll", "hover", "wait_for", "evaluate", "extract", "request",
]);
const MAX_SCROLL_PIXELS = 100_000;

/**
 * Defense against a self-heal proposal shaped by prompt injection: the LLM's evidence is
 * LIVE, untrusted content from the target site (HTML or a raw response body). A
 * compromised or adversarial page could embed text that manipulates the LLM into
 * proposing a step that does something the "fix a broken selector" framing never
 * intended — and the very next stage (verify-by-replay) EXECUTES the candidate for
 * real, with the playbook's real secrets, BEFORE any decision to persist. Checked here,
 * before runPlaybook() ever sees the candidate — never after. Returns null when the
 * proposal is safe, or a human-readable reason string when it's rejected.
 *
 * Covers three vectors (the first was the original fix; the other two were found by a
 * follow-up review, 2026-07-15, since only checking URLs left `evaluate`/`scroll` open):
 *   1. `navigate`/`request` steps whose `url` resolves off the playbook's own domain —
 *      would exfiltrate secrets attached as request headers during verification.
 *   2. `evaluate` steps — arbitrary JS run in the PAGE's browser context. Even though
 *      Node-side secrets aren't directly reachable from page JS, a page already carries
 *      an injected session cookie (T2 auth) and can beacon authenticated requests to an
 *      attacker host. The LLM has no legitimate reason to AUTHOR new JS as a fix for a
 *      selector/response-shape break, so only an evaluate step whose `script` is
 *      byte-identical to one already present in the ORIGINAL recorded playbook is
 *      allowed through (a harmless pass-through, e.g. an unrelated lazy-load trigger) —
 *      any new or modified script is rejected outright.
 *   3. `scroll` steps' `pixels` — playbook-runner.ts's executeBrowserStep builds a
 *      `page.evaluate()` string from this value; it's now defended at the source too
 *      (JSON.stringify after clamping), but this validator rejects an out-of-range or
 *      non-numeric value before the candidate is ever replayed at all.
 */
function validateHealProposal(proposedSteps: PlaybookStep[], originalSteps: PlaybookStep[], domain: string): string | null {
  const lowerDomain = domain.toLowerCase().replace(/\.+$/, "");
  const originalEvaluateScripts = new Set(
    originalSteps.filter((s) => s.op === "evaluate" && typeof s.script === "string").map((s) => s.script as string),
  );

  for (const step of proposedSteps) {
    if (!ALLOWED_STEP_OPS.has(step.op)) return `unknown step op "${step.op}"`;

    if (step.url) {
      let hostname: string;
      try {
        const parsed = new URL(step.url);
        if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) return `disallowed URL protocol in "${step.url}"`;
        hostname = parsed.hostname.toLowerCase();
      } catch {
        return `unparseable step URL "${step.url}"`; // an unparseable URL is never safe to trust
      }
      if (hostname !== lowerDomain && !hostname.endsWith(`.${lowerDomain}`)) return `off-domain step URL "${step.url}"`;
    }

    if (step.op === "evaluate" && (typeof step.script !== "string" || !originalEvaluateScripts.has(step.script))) {
      return "proposal introduces a new or modified evaluate step";
    }

    if (step.op === "scroll" && step.pixels !== undefined) {
      if (!Number.isInteger(step.pixels) || step.pixels < -MAX_SCROLL_PIXELS || step.pixels > MAX_SCROLL_PIXELS) {
        return `scroll pixels out of bounds: ${JSON.stringify(step.pixels)}`;
      }
    }

    // A T0 request step's response_pattern is a regex the runner executes SYNCHRONOUSLY
    // against the response body — a catastrophic-backtracking shape (isUnsafeResponsePattern,
    // shared with the runner itself) would hang the worker's event loop for the length of
    // the run, same class of risk as the evaluate/scroll checks above.
    if (step.op === "request" && step.request?.response_format === "text" && step.request.response_pattern) {
      if (isUnsafeResponsePattern(step.request.response_pattern)) {
        return `unsafe response_pattern: ${JSON.stringify(step.request.response_pattern)}`;
      }
    }
  }
  return null;
}

/** Re-fetch evidence of the page's current state, transport-specific. Never throws —
 *  returns an empty string (and lets the LLM/verify step fail closed) rather than
 *  aborting the whole heal attempt on a single fetch error. */
async function fetchPageState(
  playbook: Playbook,
  secrets: Record<string, string>,
  brokeStep: PlaybookStep | undefined,
): Promise<string> {
  const log = childLogger({ queue: "playbook-heal", transport: playbook.transport, name: playbook.name });

  if (playbook.transport === "http") {
    // Prefer the step that actually broke — a T0 playbook can chain multiple `request`
    // steps (runHttp replays all of them in order), so re-fetching the first one is
    // wrong whenever a LATER request is the one whose shape changed (bug found in
    // review, 2026-07-15: this used to always grab .find()'s first match).
    const reqStep =
      brokeStep?.op === "request" && brokeStep.request && brokeStep.url
        ? brokeStep
        : playbook.steps.find((s) => s.op === "request" && s.request && s.url);
    if (!reqStep?.request || !reqStep.url) return "";

    const headers: Record<string, string> = {};
    for (const [name, raw] of Object.entries(reqStep.request.headers ?? {})) {
      const resolved = resolveSecretHeader(raw, secrets);
      if (resolved !== undefined) headers[name] = resolved;
    }

    const stealth = new StealthClient({ timeout: DEFAULT_TIMEOUT_MS });
    try {
      try {
        const res = await stealth.request(reqStep.request.method || "GET", reqStep.url, {
          headers,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        return res.text;
      } catch (err) {
        if (!(err instanceof TLSFingerprintError)) throw err;
        const res = await fetch(reqStep.url, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
        return await res.text();
      }
    } catch (err) {
      log.warn("heal: failed to fetch fresh T0 response", { error: (err as Error).message });
      return "";
    } finally {
      await stealth.close().catch(() => {});
    }
  }

  // http_render (T1). Transport is a closed enum ("http" | "http_render" | "browser");
  // "browser" is handled by captureBrowserStateBeforeBreak instead (it needs
  // broke_at_index to know how far to replay, which this function doesn't take).
  const navStep = playbook.steps.find((s) => s.op === "navigate" && s.url);
  if (!navStep?.url) return "";
  try {
    const res = await fetch(navStep.url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    return await res.text();
  } catch (err) {
    log.warn("heal: failed to fetch fresh T1 HTML", { error: (err as Error).message });
    return "";
  }
}

/** Replays steps [0, stopBeforeIndex) in a live browser and returns the resulting HTML.
 *  Mirrors runBrowser()'s own replay semantics: an OPTIONAL step that fails is skipped,
 *  not fatal (bug found in review, 2026-07-15 — this used to stop evidence-gathering
 *  dead on ANY pre-break failure, including a routine optional cookie-banner dismiss
 *  that simply didn't apply this run, truncating the captured HTML far earlier than the
 *  actual break and starving the LLM of the page state it needed). A REQUIRED step that
 *  fails is still swallowed (best-effort evidence gathering — the verify-by-replay step
 *  is the real correctness gate, not this), but logged louder since it means the real
 *  break point is earlier than `stopBeforeIndex` reported. */
async function captureBrowserStateBeforeBreak(
  playbook: Playbook,
  secrets: Record<string, string>,
  stopBeforeIndex: number | undefined,
): Promise<string> {
  const log = childLogger({ queue: "playbook-heal", transport: "browser", name: playbook.name });
  const navStep = playbook.steps.find((s) => s.op === "navigate" && s.url);
  const startUrl = navStep?.url ?? `https://${playbook.domain}/`;
  const { page, close } = await openAbrasioPersistentPage(startUrl, DEFAULT_TIMEOUT_MS);

  try {
    if (secrets.session_cookie) {
      const cookies = parseCookieString(secrets.session_cookie, `.${playbook.domain}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).context().addCookies(cookies);
    }

    const limit = stopBeforeIndex ?? playbook.steps.length;
    for (let i = 0; i < limit && i < playbook.steps.length; i++) {
      const step = playbook.steps[i];
      try {
        await executeBrowserStep(page, step, secrets);
      } catch (err) {
        if (step.optional) {
          log.warn("heal: optional pre-break step failed — skipping, not stopping", {
            index: i,
            error: (err as Error).message,
          });
          continue;
        }
        log.warn("heal: required pre-break step failed — evidence may predate the real break", {
          index: i,
          error: (err as Error).message,
        });
        break;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (page as any).content();
  } finally {
    await close();
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export async function processPlaybookHealJob(job: Job<PlaybookHealJobData>): Promise<PlaybookHealJobResult> {
  const log = childLogger({ jobId: job.id, queue: "playbook-heal" });
  const start = Date.now();
  const { playbook, secrets = {}, broke_at_index, broke_step, reason, playbook_id, group_id } = job.data;

  log.info("Playbook heal job started", {
    name: playbook?.name,
    domain: playbook?.domain,
    transport: playbook?.transport,
    reason,
  });

  await job.updateProgress({ phase: "gathering_evidence", pct: 10 });
  const pageState =
    playbook.transport === "browser"
      ? await captureBrowserStateBeforeBreak(playbook, secrets, broke_at_index)
      : await fetchPageState(playbook, secrets, broke_step);

  await job.updateProgress({ phase: "proposing_fix", pct: 40 });
  const proposal = await proposeHeal({ playbook, brokeAtIndex: broke_at_index, brokeStep: broke_step, reason, pageState });
  if (!proposal) {
    log.warn("Playbook heal: no proposal from LLM", { name: playbook?.name });
    return { success: false, healed: false, reason: "no_proposal", processing_time_ms: Date.now() - start };
  }

  const validationError = validateHealProposal(proposal.steps, playbook.steps, playbook.domain);
  if (validationError) {
    // Reject BEFORE verification — runPlaybook() below would execute the candidate for
    // real, with real secrets, and we must never let an unsafe step run even once.
    log.error("Playbook heal: proposal rejected by safety validator (possible prompt injection from page evidence)", {
      name: playbook?.name,
      domain: playbook?.domain,
      reason: validationError,
    });
    return { success: false, healed: false, reason: "unsafe_proposal", processing_time_ms: Date.now() - start };
  }

  await job.updateProgress({ phase: "verifying_fix", pct: 70 });
  const candidate: Playbook = { ...playbook, steps: proposal.steps };
  const verifyRun = await runPlaybook(candidate, secrets);
  if (!verifyRun.ok) {
    log.warn("Playbook heal: proposed fix still broken — not persisting", {
      name: playbook?.name,
      reason: verifyRun.reason,
    });
    return {
      success: false,
      healed: false,
      reason: verifyRun.reason ?? "still_broken",
      processing_time_ms: Date.now() - start,
    };
  }

  await job.updateProgress({ phase: "persisting", pct: 90 });
  try {
    const res = await fetch(`${config.SCRAPETECH_API_URL}/api/playbooks/${playbook_id}/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": config.INTERNAL_SERVICE_KEY },
      body: JSON.stringify({
        name: playbook.name,
        domain: playbook.domain,
        transport: playbook.transport,
        steps: proposal.steps,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      log.error("Playbook heal: failed to persist healed version", { status: res.status, body: text });
      return { success: false, healed: false, reason: "persist_failed", processing_time_ms: Date.now() - start };
    }
  } catch (err) {
    log.error("Playbook heal: error persisting healed version", { error: (err as Error).message });
    return { success: false, healed: false, reason: "persist_failed", processing_time_ms: Date.now() - start };
  }

  await job.updateProgress({ phase: "done", pct: 100 });
  log.info("Playbook heal succeeded", { name: playbook?.name, group_id, ms: Date.now() - start });
  return { success: true, healed: true, processing_time_ms: Date.now() - start };
}
