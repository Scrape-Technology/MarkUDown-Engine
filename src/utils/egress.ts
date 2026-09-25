// src/utils/egress.ts
//
// Política ÚNICA de egress para sites ALVO.
//
// REGRA (CEO): toda requisição a um site alvo (marketplaces, redes sociais, buscadores,
// Meta Ad Library, PDFs, sitemaps, redirects de resultado de busca...) sai pelo IP de um
// proxy APROVADO (hoje Geonode; IPs ISP estáticos IPRoyal a caminho). A guarda é agnóstica
// de provedor: qualquer proxy aprovado configurado satisfaz; nenhum configurado = falha.
//
// PONTO DE EXTENSÃO (IPRoyal): as 4 funções abaixo obtêm o proxy só de proxy-region.ts
// (`getX(...) ?? deny(...)`). Ao chegar um provedor novo, encadeie-o ali —
// `getX(...) ?? novoProvedorX(...) ?? deny(...)` — sem tocar nos chamadores. Formato de
// credencial/env do IPRoyal: a definir quando as credenciais existirem (nada inventado aqui). NADA sai pelo IP da máquina/ECS onde o worker roda. Fail-CLOSED: sem proxy
// aplicável, a requisição falha com EgressPolicyError — nunca cai numa conexão direta.
//
// Chamadas INTERNAS (python-llm, chassi API, Redis, Postgres, serviço Go de markdown,
// webhooks do cliente) NÃO são alvo e não passam por aqui.
//
// Todo código que fala com um alvo obtém o proxy por estas funções (proxyAgentFor /
// proxyUrlFor / playwrightProxyFor / poolKeyFor). tests/egress-guard.test.ts varre src/ e
// falha se surgir um fetch( fora da allowlist de chamadas internas.
//
// REQUIRE_PROXY_EGRESS=false (só dev local) desliga o fail-closed: as funções voltam a
// devolver `undefined` (conexão direta) e o processo loga um aviso alto.
//
// Abrasio: toda sessão leva proxy aprovado EXPLÍCITO (abrasioProxyFor). Única exceção: pool
// `hard` (home server), controlada por EGRESS_HARD_HOME_ALLOWED.

import type { ProxyAgent } from "undici";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { maskProxy } from "./proxy-pool.js";
import { resolveBrowserProxy, type Pool } from "./proxy-policy.js";
import {
  GOOGLE_COUNTRY_KEY,
  getApprovedProxy,
  getPlaywrightProxyForCountry,
  getProxyAgentForUrl,
  getProxyUrlForUrl,
  inferCountryFromUrl,
  type PlaywrightProxy,
} from "./proxy-region.js";

export class EgressPolicyError extends Error {
  readonly code = "EGRESS_POLICY_VIOLATION";
  constructor(message: string, readonly target?: string) {
    super(message);
    this.name = "EgressPolicyError";
  }
}

export function isProxyEgressRequired(): boolean {
  return config.REQUIRE_PROXY_EGRESS;
}

const _warned = new Set<string>();
function warnBypass(what: string): void {
  if (_warned.has(what)) return;
  _warned.add(what);
  logger.warn(
    `!!! REQUIRE_PROXY_EGRESS=false — ${what} sai DIRETO pelo IP desta máquina (sem proxy). ` +
      "Isso viola a regra de egress; use apenas em dev local.",
  );
}

function missingMessage(country: string, target?: string): string {
  const vars =
    country === GOOGLE_COUNTRY_KEY
      ? "GOOGLE_PROXY_URL / GOOGLE_PROXY_USERNAME / GOOGLE_PROXY_PASSWORD"
      : "PROXY_URL / PROXY_USERNAME / PROXY_PASSWORD (ou outro provedor aprovado)";
  return (
    `Egress bloqueado (fail-closed): nenhum proxy aprovado configurado para ${country}` +
    `${target ? ` (${safeHost(target)})` : ""} — configure ${vars}. ` +
    "Definir REQUIRE_PROXY_EGRESS=false só é permitido em dev local."
  );
}

/** Host only — never log full URLs (query strings can carry tokens). */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "url-invalida";
  }
}

function deny(country: string, target?: string): undefined {
  if (config.REQUIRE_PROXY_EGRESS) throw new EgressPolicyError(missingMessage(country, target), target);
  warnBypass(target ? safeHost(target) : `país ${country}`);
  return undefined;
}

/** undici dispatcher for a target URL. Throws EgressPolicyError when no proxy applies (policy on). */
export function proxyAgentFor(url: string, country?: string, city?: string): ProxyAgent | undefined {
  return getProxyAgentForUrl(url, country, city) ?? deny(country ?? inferCountryFromUrl(url), url);
}

/** Proxy URL (credentials embedded) for URL-taking clients such as StealthClient. */
export function proxyUrlFor(url: string, country?: string, city?: string): string | undefined {
  return getProxyUrlForUrl(url, country, city) ?? deny(country ?? inferCountryFromUrl(url), url);
}

/** Patchright/Playwright proxy option for an explicit country key (or GOOGLE_COUNTRY_KEY). */
export function playwrightProxyFor(country: string, city?: string): PlaywrightProxy | undefined {
  return getPlaywrightProxyForCountry(country, city) ?? deny(country.toUpperCase());
}

/**
 * Browser pool key. "NONE" (a no-proxy context) exists ONLY when the policy is off;
 * with REQUIRE_PROXY_EGRESS it is unreachable — a missing proxy throws instead.
 */
export function poolKeyFor(country: string): string {
  const key = country.toUpperCase();
  return getPlaywrightProxyForCountry(key) ? key : (deny(key), "NONE");
}

/**
 * Gate for every path that hands a target URL to Abrasio.
 *
 *  - LOCAL mode (ABRASIO_API_URL=local, no key): the browser runs on THIS host and
 *    buildAbrasioConfig() passes no proxy => the target sees this machine's IP. Blocked
 *    while the policy is on.
 *  - CLOUD mode: the exit IP would be chosen by abrasio-api (probed 2026-09-24: residential
 *    BR ISPs of a provider NOT verifiable from here). So the cloud is never left to choose:
 *    abrasioProxyFor() hands it an explicit approved proxy, which the cloud honors (proven by
 *    IP echo: with city riodejaneiro the exit was Rio).
 */
export function assertAbrasioEgress(target?: string): void {
  if (config.ABRASIO_API_KEY) return;
  if (config.ABRASIO_API_URL === "local") {
    if (config.REQUIRE_PROXY_EGRESS) {
      throw new EgressPolicyError(
        "Egress bloqueado (fail-closed): Abrasio em modo local sai pelo IP desta máquina " +
          "(buildAbrasioConfig não aplica proxy).",
        target,
      );
    }
    warnBypass("Abrasio local");
  }
}

export interface AbrasioEgress {
  proxy?: { server: string; username?: string; password?: string };
  pool?: Pool;
  /** IP ISP estático esperado como IP de saída (prova de egress no gate de prontidão). */
  ispIp?: string;
  /** host:porta, sem credenciais. */
  label?: string;
}

/**
 * Approved proxy that EVERY Abrasio session must carry (abrasioFetch, AbrasioSession,
 * openAbrasioPersistentPage all go through buildAbrasioConfig -> here). Pool selection
 * (IPRoyal ISP / Geonode sticky / Google ...) is the central table in proxy-policy.ts.
 * An explicit `opts.proxy` (dataset with country/city) wins. Throws EgressPolicyError when no
 * approved proxy exists (policy on).
 *
 * `hard` sessions run on the Abrasio HOME server. Decision of the CEO: they must NOT burn the
 * home residential IP, so they should exit via Geonode sticky BR. BUT the home worker source
 * (server_entrypoint.py, StandaloneManager) has `#proxy=client_proxy` commented out — it
 * receives and logs the proxy without applying it — so nothing proves it works. Default
 * (EGRESS_HARD_HOME_ALLOWED=false) is therefore fail-closed; true = accept that risk (the proxy
 * is still sent, and will be honored once the worker applies it).
 */
export async function abrasioEgressFor(
  target: string,
  opts: { proxy?: { server: string; username?: string; password?: string }; region?: string; city?: string; hard?: boolean } = {},
): Promise<AbrasioEgress> {
  assertAbrasioEgress(target);
  if (opts.hard && !config.EGRESS_HARD_HOME_ALLOWED) {
    throw new EgressPolicyError(
      `Egress bloqueado (fail-closed): ${safeHost(target)} usa o pool hard (home server) e o worker home ` +
        "não comprovadamente aplica o proxy da sessão (EGRESS_HARD_HOME_ALLOWED=false).",
      target,
    );
  }
  if (opts.proxy) return { proxy: opts.proxy, label: maskProxy(opts.proxy) };
  const r = await resolveBrowserProxy({ url: target, region: opts.region, city: opts.city, hard: opts.hard });
  if (r) return { proxy: r.proxy, pool: r.pool, ispIp: r.ispIp, label: r.label };
  const country = (opts.region ?? inferCountryFromUrl(target)).toUpperCase();
  deny(country, target);
  return {};
}

if (!config.REQUIRE_PROXY_EGRESS) {
  logger.warn(
    "!!! REQUIRE_PROXY_EGRESS=false — regra de egress DESLIGADA: requisições a alvos podem sair " +
      "pelo IP direto desta máquina. Somente dev local.",
  );
}
