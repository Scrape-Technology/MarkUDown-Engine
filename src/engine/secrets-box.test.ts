import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// Pinned AES-GCM envelope (spec correction C3), identical to the Python box:
//   key   = base64decode(PLAYBOOK_SECRET_KEY) -> 32 bytes (AES-256)
//   nonce = 12 random bytes per seal
//   blob  = base64( nonce[12] ‖ ciphertext ‖ tag[16] )   (no AAD)
// A blob sealed by Python must open here and vice-versa. The reference
// helpers below are the exact byte layout the Python `cryptography` side emits.

const RAW_KEY = Buffer.alloc(32, 0x11);
const KEY_B64 = RAW_KEY.toString("base64");

// Load the box AFTER setting the env key (module may read it at import time).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let box: any;

beforeAll(async () => {
  process.env.PLAYBOOK_SECRET_KEY = KEY_B64;
  box = await import("./secrets-box.js");
});

// seal/open operate on a `{secret_ref: value}` MAP (spec C3: "plaintext: utf-8 JSON of
// the secrets object"), not a single scalar string — matching both the TS and Python
// implementations.
function resolve(names: string[]): (arg: unknown) => unknown {
  for (const n of names) {
    if (typeof box[n] === "function") return box[n];
  }
  throw new Error(`secrets-box exposes none of ${names.join(", ")}`);
}
const seal = (secrets: Record<string, string>) =>
  resolve(["seal", "sealSecret", "encrypt"])(secrets) as string;
const open = (blob: string) =>
  resolve(["open", "openSecret", "unseal", "decrypt"])(blob) as Record<string, string>;

// Reference (stands in for the Python side) using the pinned layout.
function refSeal(raw: Buffer, secrets: Record<string, string>): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", raw, nonce);
  const plaintext = JSON.stringify(secrets);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag(); // trailing 16 bytes
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}
function refOpen(raw: Buffer, blob: string): Record<string, string> {
  const buf = Buffer.from(blob, "base64");
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", raw, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext);
}

describe("secrets-box — roundtrip", () => {
  it("seals then opens", () => {
    const secrets = { session_token: "session-token-abc-123" };
    expect(open(seal(secrets))).toEqual(secrets);
  });

  it("handles an empty map, unicode, and long values", () => {
    expect(seal({})).toBe(""); // spec: empty map -> ""
    expect(open("")).toEqual({});
    const cases: Record<string, string>[] = [
      { unicode: "café-Ω" },
      { long: "x".repeat(4096) },
      { a: "1", b: "2", c: "3" },
    ];
    for (const secrets of cases) {
      expect(open(seal(secrets))).toEqual(secrets);
    }
  });
});

describe("secrets-box — pinned envelope / cross-language interop (C3)", () => {
  it("opens a blob produced by the pinned layout (as Python would emit)", () => {
    const secrets = { session_token: "python-sealed-payload" };
    const blob = refSeal(RAW_KEY, secrets);
    expect(open(blob)).toEqual(secrets);
  });

  it("its own blob decodes with the pinned layout (so Python can open it)", () => {
    const secrets = { session_token: "node-sealed-opens-in-python" };
    const blob = seal(secrets);
    const buf = Buffer.from(blob, "base64");
    // nonce(12) + tag(16) + ciphertext(len)
    expect(buf.length).toBeGreaterThanOrEqual(12 + 16 + Buffer.byteLength(JSON.stringify(secrets)));
    expect(refOpen(RAW_KEY, blob)).toEqual(secrets);
  });

  it("uses a fresh nonce per seal (non-deterministic ciphertext)", () => {
    expect(seal({ a: "same" })).not.toBe(seal({ a: "same" }));
  });
});

describe("secrets-box — failure modes", () => {
  it("does not leak plaintext into the blob", () => {
    const marker = "PLAINTEXT_MARKER";
    expect(seal({ ref: marker })).not.toContain(marker);
  });

  it("rejects a tampered blob (AES-GCM auth tag)", () => {
    const blob = seal({ ref: "integrity-protected" });
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a tag byte
    const tampered = buf.toString("base64");
    expect(() => open(tampered)).toThrow();
  });

  it("fails to open under a different key", () => {
    const blob = refSeal(Buffer.alloc(32, 0x22), { ref: "top-secret" });
    expect(() => open(blob)).toThrow();
  });
});
