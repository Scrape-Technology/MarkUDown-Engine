// src/utils/hard-route.ts
//
// Some targets are hard enough (aggressive anti-bot, or the data simply isn't
// reachable without a persistent logged-in session) that the normal Layer
// 1/2/3 ladder is a waste of time and budget — Shopee is the first case:
// Abrasio's home-server worker pool has a Shopee account already logged in,
// so a request there succeeds in one shot where the cloud fleet (no session,
// fresh fingerprint every time) would just get walled. `hard=True` on the
// Abrasio session tells abrasio-api to route to that pool instead of the
// normal ECS Fargate fleet — see abrasio-api's session-creation schema.
//
// Membership here is a manual opt-in (config.HARD_ROUTE_DOMAINS), not
// anything auto-detected from failure patterns — same tradeoff as
// domain-throttle.ts's cap: cheap and explicit beats a heuristic that could
// misfire.

import { config } from "../config.js";

const HARD_DOMAINS = new Set(
  config.HARD_ROUTE_DOMAINS.split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * True when `domain` (or a parent of it — e.g. "www.shopee.com.br" matches a
 * configured "shopee.com.br") should skip straight to Abrasio's home-server
 * pool instead of the normal extraction ladder.
 */
export function isHardRouteDomain(domain: string | null): boolean {
  if (!domain) return false;
  if (HARD_DOMAINS.has(domain)) return true;
  for (const configured of HARD_DOMAINS) {
    if (domain.endsWith(`.${configured}`)) return true;
  }
  return false;
}
