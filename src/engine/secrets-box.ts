/**
 * secrets-box — AES-GCM open/seal for Playbook `secrets_enc` (spec 2026-07-10, C3).
 *
 * Interops byte-for-byte with the Python side (api/app/security/secrets_box.py). A
 * Python-seal → Node-open round-trip is an acceptance test.
 *
 * ── WIRE FORMAT (MUST match the Python implementation EXACTLY) ──────────────────────
 *   cipher   : AES-256-GCM
 *   key      : base64decode(PLAYBOOK_SECRET_KEY) → 32 raw bytes (NOT a passphrase/hash)
 *   nonce    : 12 random bytes per seal (96-bit)
 *   aad      : none
 *   plaintext: utf-8 JSON of the secrets object
 *   blob     : nonce(12) ‖ ciphertext ‖ tag(16)   (Node getAuthTag() is the trailing 16
 *              bytes; Python `AESGCM.encrypt` returns ciphertext‖tag with nonce prepended)
 *   string   : standard base64 of `blob`
 *
 * NOTE: In the Milestone-1 hot path the API opens `secrets_enc` and passes the plaintext
 * secrets map inline in the job payload (spec C2), so `open()` here is used by the
 * cross-language acceptance test and the M2 token-refresh path rather than the replay
 * runner. It is kept exact so those paths interoperate.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const NONCE_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  const raw = process.env.PLAYBOOK_SECRET_KEY;
  if (!raw) {
    throw new Error("PLAYBOOK_SECRET_KEY is not set — cannot open/seal playbook secrets");
  }
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) {
    throw new Error(
      `PLAYBOOK_SECRET_KEY must be base64 of exactly 32 bytes (AES-256); got ${k.length}`,
    );
  }
  return k;
}

/** Encrypt a `{secret_ref: value}` map → base64 blob. Returns "" for an empty map. */
export function seal(secrets: Record<string, string>): string {
  if (!secrets || Object.keys(secrets).length === 0) return "";
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // trailing 16 bytes
  return Buffer.concat([nonce, ciphertext, tag]).toString("base64");
}

/** Decrypt a base64 blob produced by either side's `seal` back into the secrets map. */
export function open(blob: string | null | undefined): Record<string, string> {
  if (!blob) return {};
  const data = Buffer.from(blob, "base64");
  const nonce = data.subarray(0, NONCE_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  const ciphertext = data.subarray(NONCE_LEN, data.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key(), nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
}
