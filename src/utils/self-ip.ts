// src/utils/self-ip.ts
//
// The worker's OWN public egress IP (ECS NAT / home), learned at boot with ONE direct echo.
// EXCEPTION to the egress rule, deliberately: checkip.amazonaws.com is infrastructure (an IP
// echo), not a scraping target, and the call must go DIRECT — through a proxy it would echo
// the proxy, which is useless. The result joins EGRESS_FORBIDDEN_IPS at runtime so the Abrasio
// readiness gate refuses a session whose exit IP is this machine's even when the env var is
// empty. Allowlisted in tests/egress-guard.test.ts.

import { logger } from "./logger.js";

export const SELF_IP_ECHO_URL = "https://checkip.amazonaws.com";
const TIMEOUT_MS = 5_000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

let _selfIp: Promise<string | undefined> | null = null;

async function detect(): Promise<string | undefined> {
  try {
    const res = await fetch(SELF_IP_ECHO_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ip = (await res.text()).trim();
    if (!IPV4.test(ip)) throw new Error("echo did not return an IPv4");
    logger.info("Worker own egress IP detected (forbidden as proxy exit)", { ip });
    return ip;
  } catch (err) {
    logger.warn("Could not detect the worker's own egress IP; gate relies on EGRESS_FORBIDDEN_IPS only", {
      error: String(err).slice(0, 120),
    });
    _selfIp = null; // try again on the next gate
    return undefined;
  }
}

/** Own public IPv4 (cached; one detection in flight at a time). undefined when unknown. */
export function getSelfIp(): Promise<string | undefined> {
  return (_selfIp ??= detect());
}

/** EGRESS_FORBIDDEN_IPS plus the worker's own IP when known. */
export async function forbiddenEgressList(configured: string): Promise<string> {
  const self = await getSelfIp();
  return self ? `${configured},${self}` : configured;
}

/** Tests only. */
export function _setSelfIp(ip: string | undefined): void {
  _selfIp = Promise.resolve(ip);
}
