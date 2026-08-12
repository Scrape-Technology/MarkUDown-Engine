/**
 * playbook-runner — deterministic replay of a compiled playbook, no LLM (spec 2026-07-10,
 * Component 2). Dispatches on `playbook.transport`:
 *
 *   T0 `http`         — StealthClient (TLS/JA3/JA4 fingerprint spoofing, no browser),
 *                       resolve `secret_ref:` headers, apply `response_path` (JSONPath)
 *                       for JSON feeds or `response_pattern` (regex) for non-JSON ones
 *                       (`response_format:"text"` — e.g. bet365's pipe-delimited odds).
 *                       Hot path for odds/price. Falls back to plain fetch only if the
 *                       native backend isn't installed (see the T0 section below).
 *   T1 `http_render`  — HTTP GET + Cheerio, extract the `extract` step's CSS `selector`
 *                       directly (deterministic, no LLM). No browser.
 *   T2 `browser`      — Abrasio persistent page, execute steps with Playwright primitives.
 *                       When auth is needed, a session cookie from `secrets.session_cookie`
 *                       is injected (spec C1 — like instagram.ts; NO profile pool in M1).
 *
 * Per spec C2 the caller resolves the full playbook (steps, transport, schema, opened
 * secrets) and hands them here — the runner never touches Postgres or the api.
 */

import * as cheerio from "cheerio";
import { fetch } from "undici";
import { StealthClient, TLSFingerprintError } from "abrasio-sdk";
import { Worker } from "node:worker_threads";
import { openAbrasioPersistentPage } from "./abrasio-engine.js";
import { parseCookieString } from "../jobs/instagram.js";
import { childLogger } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CapturedRequest {
  method: string;
  headers?: Record<string, string>;
  body_template?: string | null;
  response_path?: string | null;
  /** "json" (default) parses the body and applies `response_path` (JSONPath). "text"
   *  skips JSON parsing entirely and applies `response_pattern` (a regex) directly
   *  against the raw response body — for non-JSON feeds (e.g. bet365's pipe-delimited
   *  odds format) that response_path has no way to address. */
  response_format?: "json" | "text";
  /** Regex source (no flags) used when response_format is "text". Capture group 1 is
   *  extracted if present, otherwise the whole match. */
  response_pattern?: string | null;
}

export interface PlaybookStep {
  op: string;
  selector?: string;
  url?: string;
  text?: string;
  secret_ref?: string;
  key?: string;
  pixels?: number;
  timeout?: number;
  script?: string;
  schema?: Record<string, string>;
  request?: CapturedRequest;
  optional?: boolean;
}

/** Fully-resolved playbook as handed to the runner (schema inlined by the api, C2). */
export interface Playbook {
  id?: string;
  group_id?: string;
  name: string;
  domain: string;
  transport: "http" | "http_render" | "browser";
  steps: PlaybookStep[];
  schema?: Record<string, string> | null;
  schema_domain?: string | null;
  schema_mode?: string | null;
  profile_domain?: string | null;
}

export interface RunResult {
  ok: boolean;
  data?: unknown;
  brokeAtIndex?: number;
  brokeStep?: PlaybookStep;
  reason?: "selector" | "token" | "response_shape";
}

const DEFAULT_TIMEOUT_MS = 60_000;
// Overall wall-clock cap for a single T2 run, on top of each step's own (now-clamped)
// timeout — bug found in review, 2026-08-11: even with a bound per step, N steps at up to
// 120s each has no aggregate cap, so a long playbook could still hold a browser (one of a
// small, fixed worker pool) far longer than any single step's timeout suggests.
const MAX_BROWSER_RUN_MS = 5 * 60_000;

// ─── Secret resolution ─────────────────────────────────────────────────────────

/** Resolve a `secret_ref:<name>` or bare secret ref to its value; returns the input
 *  unchanged when it is not a reference. */
function resolveSecret(value: string, secrets: Record<string, string>): string | undefined {
  if (value == null) return value;
  if (value.startsWith("secret_ref:")) {
    const ref = value.slice("secret_ref:".length);
    return secrets[ref];
  }
  return value;
}

// ─── Minimal JSONPath (covers `$.a.b`, `[i]`, `[*]`) ───────────────────────────
// Deliberately tiny — no jsonpath dependency. Enough for captured `response_path`
// like `$.markets[*].odds`. Returns undefined if any segment fails to resolve.

function applyResponsePath(root: unknown, path: string): unknown {
  if (!path || path === "$") return root;
  const tokens = path
    .replace(/^\$\.?/, "")
    .replace(/\[(\*|\d+)\]/g, ".$1")
    .split(".")
    .filter((t) => t.length > 0);

  let current: unknown[] = [root];
  for (const tok of tokens) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node == null) continue;
      if (tok === "*") {
        if (Array.isArray(node)) next.push(...node);
        else if (typeof node === "object") next.push(...Object.values(node as object));
      } else if (/^\d+$/.test(tok)) {
        const idx = Number(tok);
        if (Array.isArray(node) && idx < node.length) next.push(node[idx]);
      } else if (typeof node === "object") {
        const v = (node as Record<string, unknown>)[tok];
        if (v !== undefined) next.push(v);
      }
    }
    current = next;
  }
  // A `[*]` wildcard yields a list; a fully-scalar path yields a single value.
  const wildcard = /\[\*\]/.test(path);
  if (wildcard) return current;
  return current.length === 1 ? current[0] : current.length === 0 ? undefined : current;
}

// ─── response_pattern (regex, for non-JSON T0 feeds) ───────────────────────────
// `response_path`/JSONPath has no way to address a pipe/CSV-delimited body (bet365's
// odds feed is exactly this shape) — response_pattern covers that case with a plain
// regex instead. Exported so playbook-heal.ts's validator can reject an unsafe PROPOSED
// pattern before ever replaying it (a self-heal proposal is shaped by untrusted page
// content, unlike an owner-authored `steps` pattern from RECORD — same trust boundary
// as the other self-heal safety checks).

const MAX_RESPONSE_PATTERN_LENGTH = 200;
const MAX_RESPONSE_PATTERN_MATCH_TEXT_LENGTH = 500_000;
const RESPONSE_PATTERN_EXEC_TIMEOUT_MS = 500;
const RESPONSE_PATTERN_MAX_MATCHES = 1000;

/** Cheap first-pass heuristic for the classic catastrophic-backtracking shape: a
 *  quantified group that itself contains a quantifier, e.g. `(a+)+`, `(a*)*`,
 *  `([a-z]+)*`. Kept as a fast reject for obviously-bad patterns (and so
 *  playbook-heal.ts's proposal validator can still reject before ever attempting
 *  execution) — but NOT the actual defense against ReDoS. Bug found in review,
 *  2026-08-11: this heuristic denylist misses alternation-based backtracking, e.g.
 *  `(a|a)*$` passes it and hangs the event loop for seconds on a 30-char input (a proven,
 *  measured 27s at 30 chars). ReDoS detection from a pattern's static shape alone is
 *  undecidable in general — the only reliable defense is execTimedRegex() below, which
 *  actually bounds the wall-clock time of a match attempt regardless of pattern shape. */
export function isUnsafeResponsePattern(pattern: string): boolean {
  if (!pattern || pattern.length > MAX_RESPONSE_PATTERN_LENGTH) return true;
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) return true;
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return false;
  } catch {
    return true; // an invalid regex is never safe to use
  }
}

// Inlined (not a separate file on disk) so there is exactly one runtime module-resolution
// path regardless of whether this process is running via tsx (dev), compiled dist/ (prod),
// or vitest (test) — those three environments resolve a `new Worker(new URL(...))` file
// reference differently, and a worker whose path silently fails to resolve in only ONE of
// them is exactly the kind of environment-specific breakage this fix must not introduce.
const RESPONSE_PATTERN_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { pattern, haystack, maxMatches } = workerData;
try {
  const regex = new RegExp(pattern, "g");
  const matches = [];
  let m;
  while ((m = regex.exec(haystack)) !== null) {
    matches.push(m.length > 1 ? m[1] : m[0]);
    if (m.index === regex.lastIndex) regex.lastIndex++;
    if (matches.length >= maxMatches) break;
  }
  parentPort.postMessage({ ok: true, matches });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
}
`;

/** Executes \`pattern\` against \`haystack\` inside a worker thread with a hard wall-clock
 *  timeout, terminating the worker if it doesn't finish in time. Node's regex engine is
 *  synchronous and cannot be interrupted mid-match — running it in a separate thread and
 *  killing that thread on timeout is the only way to bound the cost of a pathological
 *  pattern without also being able to enumerate every pathological SHAPE up front (see
 *  isUnsafeResponsePattern's docstring). A timeout is treated as "no match", the same
 *  outcome as isUnsafeResponsePattern rejecting the pattern before ever running it. */
function execTimedRegex(pattern: string, haystack: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(RESPONSE_PATTERN_WORKER_SOURCE, {
        eval: true,
        workerData: { pattern, haystack, maxMatches: RESPONSE_PATTERN_MAX_MATCHES },
      });
    } catch {
      resolve(null);
      return;
    }
    const finish = (result: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), RESPONSE_PATTERN_EXEC_TIMEOUT_MS);
    worker.once("message", (msg: { ok: boolean; matches?: string[] }) => {
      finish(msg.ok && msg.matches ? msg.matches : null);
    });
    worker.once("error", () => finish(null));
  });
}

async function applyResponsePattern(bodyText: string, pattern: string): Promise<unknown> {
  if (isUnsafeResponsePattern(pattern)) return undefined;
  const haystack = bodyText.length > MAX_RESPONSE_PATTERN_MATCH_TEXT_LENGTH
    ? bodyText.slice(0, MAX_RESPONSE_PATTERN_MATCH_TEXT_LENGTH)
    : bodyText;

  const matches = await execTimedRegex(pattern, haystack);
  if (!matches || matches.length === 0) return undefined;
  return matches.length === 1 ? matches[0] : matches;
}

// ─── Step URL validation (SSRF / off-domain guard) ─────────────────────────────
// Bug found in review, 2026-08-11: playbook-heal.ts's validateHealProposal enforces this
// exact check on an LLM-PROPOSED url, but nothing enforced it on ordinary replay of a
// playbook's own recorded steps — a step's url living in the same database row as the
// playbook's secrets isn't inherently safe just because it wasn't LLM-derived (a bad
// domain/url pairing at RECORD time, or a playbook whose `steps` were altered after the
// fact, replayed off-domain with secret headers attached, with nothing upstream
// checking it). Exported so playbook-heal.ts imports this instead of hand-duplicating it.

export const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

export function isAllowedStepUrl(url: string, domain: string): boolean {
  const lowerDomain = domain.toLowerCase().replace(/\.+$/, "");
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) return false;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === lowerDomain || hostname.endsWith(`.${lowerDomain}`);
}

// ─── T0: http ──────────────────────────────────────────────────────────────────
// Wired to abrasio-sdk's StealthClient 2026-07-15 (was plain undici.fetch through M1).
// Proven necessary against a real target the same session: bet365.bet.br's odds feed
// has no session/auth requirement but IS behind TLS-fingerprint bot detection — a bare
// fetch()/httpx.get() gets an immediate 403 regardless of headers, while StealthClient
// (curl-impersonate via FFI) gets a clean 200 with the same real data, no browser
// needed (~375ms measured, vs ~15-20s+ for a full T2 browser session). StealthClient is
// the default, not opt-in — it's still dramatically cheaper than T2, and most real T0
// targets worth compiling a playbook for are exactly the kind that fingerprint bots.

interface HttpResult { statusCode: number; bodyText: string }

async function runHttp(playbook: Playbook, secrets: Record<string, string>): Promise<RunResult> {
  const log = childLogger({ queue: "playbook", transport: "http", name: playbook.name });
  const results: unknown[] = [];

  const requestSteps = playbook.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.op === "request" && step.request);

  // One client for the whole run — reuses the underlying session/connection across
  // multiple `op:"request"` steps in the same playbook. Constructing it is cheap and
  // lazy (no native/session work happens until the first real request), so this is
  // safe even when the stealth backend isn't installed.
  const stealth = new StealthClient({ timeout: DEFAULT_TIMEOUT_MS });
  let useStealth = true;

  // `allowRedirects: false` / `redirect: "manual"` whenever the request carries a
  // resolved secret header — bug found in review, 2026-08-11: undici (T0's fallback path)
  // only strips authorization/cookie/proxy-authorization on a cross-origin redirect, NOT
  // arbitrary header names, which is exactly what a `secret_ref` header usually is
  // (X-Api-Key, X-Auth-Token, ...); a same-origin off-domain check on the STEP's url is
  // worthless if the target then 302s the request (with headers still attached) to an
  // attacker-controlled host. abrasio-sdk's StealthClient (impers) doesn't offer
  // per-redirect-hop control, so the only safe option at this layer is to never follow a
  // redirect at all when secrets are attached — a legitimate same-domain redirect simply
  // surfaces as a response_shape break instead (safe-by-default; self-heal, itself now
  // domain-scoped, can propose a fix pointed at the final URL).
  const doRequest = async (
    method: string, url: string, headers: Record<string, string>, body: string | undefined, hasSecret: boolean,
  ): Promise<HttpResult> => {
    if (useStealth) {
      try {
        const res = await stealth.request(method, url, {
          headers, data: body, timeout: DEFAULT_TIMEOUT_MS, allowRedirects: !hasSecret,
        });
        return { statusCode: res.statusCode, bodyText: res.text };
      } catch (err) {
        if (err instanceof TLSFingerprintError) {
          // Native backend (impers) not installed in this environment — fall back to
          // plain fetch for the rest of this run rather than retrying stealth per step.
          useStealth = false;
          log.warn("Stealth HTTP backend unavailable — falling back to plain fetch for T0", {
            error: err.message,
          });
        } else {
          throw err;
        }
      }
    }
    const res = await fetch(url, {
      method, headers, body, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      redirect: hasSecret ? "manual" : "follow",
    });
    return { statusCode: res.status, bodyText: await res.text() };
  };

  try {
    for (const { step, index } of requestSteps) {
      const req = step.request!;
      const url = step.url;
      if (!url) {
        if (step.optional) continue;
        return { ok: false, brokeAtIndex: index, brokeStep: step, reason: "response_shape" };
      }

      if (!isAllowedStepUrl(url, playbook.domain)) {
        log.error("T0 request step URL is off-domain or uses a disallowed protocol — refusing to replay", {
          url, domain: playbook.domain,
        });
        return { ok: false, brokeAtIndex: index, brokeStep: step, reason: "response_shape" };
      }

      const headers: Record<string, string> = {};
      let hasSecret = false;
      for (const [name, raw] of Object.entries(req.headers ?? {})) {
        const resolved = resolveSecret(raw, secrets);
        if (resolved === undefined) {
          // A required token header could not be resolved → treat as a dead token.
          log.warn("Unresolved secret header", { header: name });
          return { ok: false, brokeAtIndex: index, brokeStep: step, reason: "token" };
        }
        if (raw.startsWith("secret_ref:")) hasSecret = true;
        headers[name] = resolved;
      }

      let result: HttpResult;
      try {
        result = await doRequest(req.method || "GET", url, headers, req.body_template ?? undefined, hasSecret);
      } catch (err) {
        if (step.optional) continue;
        log.error("T0 request failed", { url, error: (err as Error).message });
        return { ok: false, brokeAtIndex: index, brokeStep: step, reason: "response_shape" };
      }

      // 401/403 = dead token → refresh, not a heal (spec break semantics per tier).
      if (result.statusCode === 401 || result.statusCode === 403) {
        return { ok: false, brokeAtIndex: index, brokeStep: step, reason: "token" };
      }

      if (req.response_format === "text") {
        // Non-JSON feed (e.g. bet365's pipe-delimited odds) — never JSON.parse, apply
        // response_pattern (regex) directly against the raw body instead.
        const pattern = req.response_pattern;
        if (pattern) {
          const extracted = await applyResponsePattern(result.bodyText, pattern);
          if (extracted === undefined) {
            return { ok: false, brokeAtIndex: index, brokeStep: step, reason: "response_shape" };
          }
          results.push(extracted);
        } else {
          results.push(result.bodyText);
        }
        continue;
      }

      let body: unknown = null;
      try { body = JSON.parse(result.bodyText); } catch { /* non-JSON body → null */ }

      const path = req.response_path;
      if (path) {
        const extracted = applyResponsePath(body, path);
        // Undefined (no match at all) or an empty wildcard match both mean the response no
        // longer has the shape the playbook was compiled against → API shape changed, heal
        // (spec). (A legitimately-empty-but-present feed, e.g. no odds off-hours, is a known
        // deferred nuance — audit N1 — not distinguished from "broken" in M1.)
        const empty = extracted === undefined || (Array.isArray(extracted) && extracted.length === 0);
        if (empty) {
          return { ok: false, brokeAtIndex: index, brokeStep: step, reason: "response_shape" };
        }
        results.push(extracted);
      } else {
        // No response_path yet (M1 capture defaults to null) → return the whole payload.
        results.push(body);
      }
    }
  } finally {
    await stealth.close().catch(() => {});
  }

  if (requestSteps.length === 0) {
    return { ok: false, reason: "response_shape" };
  }
  return { ok: true, data: results.length === 1 ? results[0] : results };
}

// ─── Schema extraction (T1/T2 terminal `extract`) ──────────────────────────────
// Deterministic, NO LLM at replay: the agent already decided what to grab during
// RECORD (a CSS `selector`), so replay just reads it back out — an LLM call here would
// violate the spec's core principle ("Normal operation is pure replay. The LLM is
// invoked only during RECORD and SELF-HEAL").

/** Extract text for a CSS selector from static HTML via Cheerio (T1). One match → a
 *  string; multiple → a string[]; none → null (treated as a break by the caller). */
function extractFromHtml(html: string, selector: string | undefined): unknown {
  if (!selector) return null;
  const $ = cheerio.load(html);
  const matches = $(selector);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches.first().text().trim();
  return matches.map((_, el) => $(el).text().trim()).get();
}

/** Same extraction, but against a live T2 page. A string body (not a typed closure)
 *  avoids requiring the DOM lib, matching the existing pattern in playwright-engine.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractFromPage(page: any, selector: string | undefined): Promise<unknown> {
  if (!selector) return null;
  return page.evaluate(`(() => {
    const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    if (els.length === 0) return null;
    const texts = els.map((el) => (el.textContent ? el.textContent.trim() : null));
    return texts.length === 1 ? texts[0] : texts;
  })()`);
}

// ─── T1: http_render ────────────────────────────────────────────────────────────

async function runHttpRender(playbook: Playbook): Promise<RunResult> {
  const log = childLogger({ queue: "playbook", transport: "http_render", name: playbook.name });
  const navStep = playbook.steps.find((s) => s.op === "navigate" && s.url);
  const extractStep = playbook.steps.find((s) => s.op === "extract");
  const url = navStep?.url;
  if (!url) return { ok: false, reason: "response_shape" };
  if (!isAllowedStepUrl(url, playbook.domain)) {
    log.error("T1 navigate step URL is off-domain or uses a disallowed protocol — refusing to replay", {
      url, domain: playbook.domain,
    });
    return { ok: false, brokeStep: navStep, reason: "response_shape" };
  }

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch (err) {
    log.error("T1 fetch failed", { url, error: (err as Error).message });
    return { ok: false, brokeStep: navStep, reason: "response_shape" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, brokeStep: navStep, reason: "token" };
  }
  const html = await res.text();
  const data = extractFromHtml(html, extractStep?.selector);
  if (data == null) {
    // The selector no longer matches → the page changed shape, heal (spec).
    return { ok: false, brokeStep: extractStep, reason: "response_shape" };
  }
  return { ok: true, data };
}

// ─── T2: browser ─────────────────────────────────────────────────────────────
// Bug found in review, 2026-07-15: parseCookieString was a byte-for-byte duplicate of
// the one already exported from ../jobs/instagram.js — imported above instead.

async function runBrowser(playbook: Playbook, secrets: Record<string, string>): Promise<RunResult> {
  const log = childLogger({ queue: "playbook", transport: "browser", name: playbook.name });
  const navStep = playbook.steps.find((s) => s.op === "navigate" && s.url);
  const startUrl = navStep?.url ?? `https://${playbook.domain}/`;

  // C1: openAbrasioPersistentPage(url, timeout) — a fresh browser per call, no profile id.
  const { page, close } = await openAbrasioPersistentPage(startUrl, DEFAULT_TIMEOUT_MS);

  try {
    // Inject a session cookie if the playbook carries one (auth without a profile pool).
    if (secrets.session_cookie) {
      const cookies = parseCookieString(secrets.session_cookie, `.${playbook.domain}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).context().addCookies(cookies);
    }

    let data: unknown = null;
    const deadline = Date.now() + MAX_BROWSER_RUN_MS;

    for (let i = 0; i < playbook.steps.length; i++) {
      if (Date.now() > deadline) {
        log.error("T2 run exceeded its overall deadline — aborting", { index: i, maxRunMs: MAX_BROWSER_RUN_MS });
        return { ok: false, brokeAtIndex: i, brokeStep: playbook.steps[i], reason: "response_shape" };
      }
      const step = playbook.steps[i];
      try {
        await executeBrowserStep(page, step, secrets, playbook.domain);
        if (step.op === "extract") {
          data = await extractFromPage(page, step.selector);
          if (data == null) {
            // The selector no longer matches → the page changed shape, heal (spec).
            return { ok: false, brokeAtIndex: i, brokeStep: step, reason: "response_shape" };
          }
        }
      } catch (err) {
        if (step.optional) {
          log.warn("Optional step failed, skipping", { index: i, op: step.op, error: (err as Error).message });
          continue;
        }
        log.error("Step failed — break", { index: i, op: step.op, error: (err as Error).message });
        return { ok: false, brokeAtIndex: i, brokeStep: step, reason: "selector" };
      }
    }

    return { ok: true, data };
  } finally {
    await close();
  }
}

// Bug found in review, 2026-08-11: `step.timeout` was passed straight through to every
// Playwright primitive with no upper bound — since it's untyped JSON at runtime (a heal
// proposal or a tampered payload could set it arbitrarily high), a single
// `{op:"wait_for", timeout: 86400000}` could hold a browser (and one of a small, fixed
// pool of worker slots) for 24 hours. Clamp it the same way `scroll.pixels` already is.
const MAX_STEP_TIMEOUT_MS = 120_000;

function clampStepTimeout(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_STEP_TIMEOUT_MS);
}

// Exported for reuse by playbook-heal.ts (Milestone 2): to gather the page state at the
// exact point a T2 playbook broke, the heal worker replays every step BEFORE the break
// index using this same primitive, rather than re-navigating to the entry URL and
// missing whatever login/click/scroll sequence got the recorded page there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeBrowserStep(page: any, step: PlaybookStep, secrets: Record<string, string>, domain: string): Promise<void> {
  const timeout = clampStepTimeout(step.timeout);
  switch (step.op) {
    case "navigate":
      if (!step.url || !isAllowedStepUrl(step.url, domain)) {
        throw new Error(`navigate step URL is off-domain or uses a disallowed protocol: ${JSON.stringify(step.url)}`);
      }
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout });
      break;
    case "click":
      await page.click(step.selector!, { timeout });
      break;
    case "fill": {
      // Resolve a secret_ref → its value; a raw `text` fills as-is. A missing secret is a
      // HARD error (not a break — spec T2), so replay never types an empty credential.
      let value: string | undefined;
      if (step.secret_ref) {
        value = secrets[step.secret_ref];
        if (value === undefined) {
          throw new Error(`Missing secret for ref '${step.secret_ref}' — cannot fill '${step.selector}'`);
        }
      } else {
        value = step.text ?? "";
      }
      await page.fill(step.selector!, value, { timeout });
      break;
    }
    case "type":
      await page.keyboard.type(step.text ?? "");
      break;
    case "press":
      await page.keyboard.press(step.key ?? "Enter");
      break;
    case "scroll": {
      // A string body (not a typed closure) avoids requiring the DOM lib here, matching
      // the existing pattern in playwright-engine.ts. `step.pixels` is untyped JSON at
      // runtime (a heal proposal or a malformed/tampered payload could put a STRING
      // there instead of a number) — coerce+clamp it to a real integer BEFORE string
      // interpolation, then JSON.stringify the validated number, so it can never inject
      // extra JS into the evaluate() string (bug found in review, 2026-07-15: the
      // un-coerced value was interpolated directly, e.g. pixels:"0);fetch('//evil');//"
      // would have executed as code).
      const raw = Number(step.pixels);
      const pixels = Number.isFinite(raw) ? Math.max(-100_000, Math.min(100_000, Math.trunc(raw))) : 800;
      await page.evaluate(`window.scrollBy(0, ${JSON.stringify(pixels)})`);
      break;
    }
    case "hover":
      await page.hover(step.selector!, { timeout });
      break;
    case "wait_for":
      await page.waitForSelector(step.selector!, { timeout });
      break;
    case "evaluate":
      await page.evaluate(step.script!);
      break;
    case "extract":
      // Handled by the caller — it reads the value via extractFromPage() after this
      // switch returns, since it needs the resolved `data` variable in runBrowser's scope.
      break;
    case "request":
      // A `request` step inside a browser playbook is a no-op here (T0 concern).
      break;
    default:
      throw new Error(`Unknown playbook op: ${step.op}`);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runPlaybook(
  playbook: Playbook,
  secrets: Record<string, string>,
): Promise<RunResult> {
  switch (playbook.transport) {
    case "http":
      return runHttp(playbook, secrets);
    case "http_render":
      return runHttpRender(playbook);
    case "browser":
      return runBrowser(playbook, secrets);
    default:
      return { ok: false, reason: "response_shape" };
  }
}
