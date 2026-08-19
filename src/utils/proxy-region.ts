import { ProxyAgent } from "undici";
import { config } from "../config.js";

// ISO-3166-1 alpha-2 mapping by ccTLD
const TLD_TO_COUNTRY: Record<string, string> = {
  // Americas
  br: "BR",
  ar: "AR",
  cl: "CL",
  co: "CO",
  mx: "MX",
  pe: "PE",
  uy: "UY",
  ve: "VE",
  ca: "CA",
  // Europe
  uk: "GB",
  gb: "GB",
  de: "DE",
  fr: "FR",
  es: "ES",
  it: "IT",
  pt: "PT",
  nl: "NL",
  be: "BE",
  ch: "CH",
  at: "AT",
  se: "SE",
  no: "NO",
  dk: "DK",
  fi: "FI",
  pl: "PL",
  cz: "CZ",
  ro: "RO",
  hu: "HU",
  sk: "SK",
  bg: "BG",
  hr: "HR",
  rs: "RS",
  gr: "GR",
  ie: "IE",
  ua: "UA",
  ru: "RU",
  tr: "TR",
  // Asia-Pacific
  jp: "JP",
  cn: "CN",
  kr: "KR",
  in: "IN",
  au: "AU",
  nz: "NZ",
  sg: "SG",
  my: "MY",
  id: "ID",
  ph: "PH",
  th: "TH",
  vn: "VN",
  // Middle East & Africa
  ae: "AE",
  sa: "SA",
  il: "IL",
  za: "ZA",
  ng: "NG",
  eg: "EG",
};

// Second-level TLD prefixes that indicate a country in the last segment
// e.g. com.br, co.uk, net.au, gov.br
const SECOND_LEVEL_PREFIXES = new Set(["com", "co", "net", "org", "gov", "edu", "adv"]);

const DEFAULT_COUNTRY = "US";

// ── google.* override ──────────────────────────────────────────────────────
// Google flags the chassis's own datacenter egress IP as "unusual traffic" on
// the very first search request, independent of target country — the normal
// per-country PROXY_URL scheme doesn't help here. Needs its own dedicated,
// sticky residential proxy. See GOOGLE_PROXY_* in config.ts.
//
// inferCountryFromUrl() returns this sentinel for any google.* host so the
// existing per-country context pool (playwright-engine.ts) naturally gives
// Google its own isolated browser + proxy without further wiring — every
// proxy getter below special-cases this key to route to GOOGLE_PROXY_* instead
// of the generic Massive per-country-suffix scheme.
export const GOOGLE_COUNTRY_KEY = "GOOGLE";

function isGoogleHost(hostname: string): boolean {
  return /(^|\.)google\.[a-z.]+$/i.test(hostname);
}

/**
 * Infer the target country from a URL's TLD.
 *
 * Examples:
 *   https://www.globo.com.br  → "BR"
 *   https://bbc.co.uk         → "GB"
 *   https://spiegel.de        → "DE"
 *   https://example.com       → "US" (generic TLD → default)
 *   https://www.google.com    → "GOOGLE" (dedicated proxy, see above)
 */
export function inferCountryFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (isGoogleHost(hostname)) return GOOGLE_COUNTRY_KEY;

    const parts = hostname.split(".");

    if (parts.length >= 3) {
      // Check second-level patterns: com.br, co.uk, net.au …
      const sld = parts[parts.length - 2];
      const tld = parts[parts.length - 1];
      if (SECOND_LEVEL_PREFIXES.has(sld) && TLD_TO_COUNTRY[tld]) {
        return TLD_TO_COUNTRY[tld];
      }
    }

    // Plain ccTLD: .br, .de, .fr …
    const tld = parts[parts.length - 1];
    return TLD_TO_COUNTRY[tld] ?? DEFAULT_COUNTRY;
  } catch {
    return DEFAULT_COUNTRY;
  }
}

function googleProxyOrUndefined(): PlaywrightProxy | undefined {
  if (!config.GOOGLE_PROXY_URL || !config.GOOGLE_PROXY_USERNAME || !config.GOOGLE_PROXY_PASSWORD) {
    return undefined;
  }
  return {
    server: config.GOOGLE_PROXY_URL,
    username: config.GOOGLE_PROXY_USERNAME,
    password: config.GOOGLE_PROXY_PASSWORD,
  };
}

// ── Per-country ProxyAgent cache (undici) ─────────────────────────────────────

const _agentCache = new Map<string, ProxyAgent>();

/**
 * Returns a cached undici ProxyAgent configured for the target URL's country.
 * Returns undefined when proxy env vars are not set.
 */
export function getProxyAgentForUrl(url: string): ProxyAgent | undefined {
  const country = inferCountryFromUrl(url);

  if (country === GOOGLE_COUNTRY_KEY) {
    const proxy = googleProxyOrUndefined();
    if (!proxy) return undefined;
    let agent = _agentCache.get(GOOGLE_COUNTRY_KEY);
    if (!agent) {
      const user = encodeURIComponent(proxy.username);
      const pass = encodeURIComponent(proxy.password);
      const proxyUri = proxy.server.replace("://", `://${user}:${pass}@`);
      agent = new ProxyAgent(proxyUri);
      _agentCache.set(GOOGLE_COUNTRY_KEY, agent);
    }
    return agent;
  }

  if (!config.PROXY_URL || !config.PROXY_USERNAME || !config.PROXY_PASSWORD) return undefined;

  let agent = _agentCache.get(country);

  if (!agent) {
    const user = encodeURIComponent(`${config.PROXY_USERNAME}${country}`);
    const pass = encodeURIComponent(config.PROXY_PASSWORD);
    // Inject credentials into the server URL: http://user:pass@host:port
    const proxyUri = config.PROXY_URL.replace("://", `://${user}:${pass}@`);
    agent = new ProxyAgent(proxyUri);
    _agentCache.set(country, agent);
  }

  return agent;
}

// ── Playwright proxy options ──────────────────────────────────────────────────

export interface PlaywrightProxy {
  server: string;
  username: string;
  password: string;
}

/**
 * Returns Playwright proxy options for the target URL's country.
 * Returns undefined when proxy env vars are not set.
 */
export function getPlaywrightProxyForUrl(url: string): PlaywrightProxy | undefined {
  return getPlaywrightProxyForCountry(inferCountryFromUrl(url));
}

/**
 * Returns Playwright proxy options for an explicit country code (e.g. "US", "BR"),
 * or the GOOGLE_COUNTRY_KEY sentinel for the dedicated Google proxy.
 * Use this when the caller already knows the target country (e.g. search endpoint).
 * Returns undefined when the relevant proxy env vars are not set.
 */
export function getPlaywrightProxyForCountry(country: string): PlaywrightProxy | undefined {
  if (country === GOOGLE_COUNTRY_KEY) return googleProxyOrUndefined();

  if (!config.PROXY_URL || !config.PROXY_USERNAME || !config.PROXY_PASSWORD) return undefined;

  return {
    server: config.PROXY_URL,
    username: `${config.PROXY_USERNAME}${country.toUpperCase()}`,
    password: config.PROXY_PASSWORD,
  };
}
