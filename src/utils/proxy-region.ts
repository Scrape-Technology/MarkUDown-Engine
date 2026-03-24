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

/**
 * Infer the target country from a URL's TLD.
 *
 * Examples:
 *   https://www.globo.com.br  → "BR"
 *   https://bbc.co.uk         → "GB"
 *   https://spiegel.de        → "DE"
 *   https://example.com       → "US" (generic TLD → default)
 */
export function inferCountryFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
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

// ── Per-country ProxyAgent cache (undici) ─────────────────────────────────────

const _agentCache = new Map<string, ProxyAgent>();

/**
 * Returns a cached undici ProxyAgent configured for the target URL's country.
 * Returns undefined when proxy env vars are not set.
 */
export function getProxyAgentForUrl(url: string): ProxyAgent | undefined {
  if (!config.PROXY_URL || !config.PROXY_USERNAME || !config.PROXY_PASSWORD) return undefined;

  const country = inferCountryFromUrl(url);
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
  if (!config.PROXY_URL || !config.PROXY_USERNAME || !config.PROXY_PASSWORD) return undefined;

  const country = inferCountryFromUrl(url);
  return {
    server: config.PROXY_URL,
    username: `${config.PROXY_USERNAME}${country}`,
    password: config.PROXY_PASSWORD,
  };
}
