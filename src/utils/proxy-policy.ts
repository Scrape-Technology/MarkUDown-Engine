// src/utils/proxy-policy.ts
//
// Política CENTRAL de roteamento de proxy para sessões de BROWSER (Abrasio). Uma tabela,
// primeira regra que casa vence; cada regra é uma lista ORDENADA de pools — o primeiro pool
// que tiver um proxy disponível é usado (ISP em cooldown/no teto/sem credencial => cai para o
// próximo, que é sempre Geonode). Nenhum pool disponível => o chamador falha FECHADO.
//
//   pool            o que é
//   isp-high        IPRoyal ISP estático, ISP real (Rio/SP)   — alta confiança
//   isp-low         IPRoyal ISP estático, M247 (hosting)      — baixa confiança, descartável
//   geonode-sticky  Geonode residencial, porta sticky (1 IP por sessão de browser)
//   geonode-rotating Geonode residencial, porta rotativa
//   google          proxy sticky dedicado GOOGLE_PROXY_* (inalterado)
//
// Cheerio/undici/StealthClient (1 request) NÃO passam por aqui: seguem em egress.ts ->
// Geonode rotativo. O Patchright genérico do dataset também segue Geonode (só Abrasio usa ISP).

import { getApprovedProxy, inferCountryFromUrl, GOOGLE_COUNTRY_KEY } from "./proxy-region.js";
import { ispToProxyOption, maskProxy, pickIsp } from "./proxy-pool.js";

export type Pool = "isp-high" | "isp-low" | "geonode-sticky" | "geonode-rotating" | "google";

export interface RouteCtx {
  url: string;
  hard?: boolean;
  city?: string;
}

interface Rule {
  why: string;
  match: (c: RouteCtx, host: string, path: string) => boolean;
  pools: Pool[];
}

const hostIs = (host: string, ...names: string[]) => names.some((n) => host === n || host.endsWith("." + n));

// Ordem importa. Comentário = por quê.
export const POLICY: Rule[] = [
  // Home server: NÃO pode queimar o IP residencial de casa (decisão do CEO).
  { why: "hard (home server)", match: (c) => !!c.hard, pools: ["geonode-sticky"] },
  // Geografia explícita: só o Geonode segmenta por cidade (o ISP é estático, cidade fixa).
  { why: "pedido com city", match: (c) => !!c.city, pools: ["geonode-sticky"] },
  { why: "Facebook Marketplace", match: (_c, h, p) => hostIs(h, "facebook.com") && p.startsWith("/marketplace"), pools: ["geonode-sticky"] },
  // Ad Library é pública e o IP é descartável => usa o ISP de baixa confiança (M247).
  { why: "Meta Ad Library", match: (_c, h, p) => hostIs(h, "facebook.com") && p.startsWith("/ads"), pools: ["isp-low", "geonode-sticky"] },
  { why: "Google", match: (_c, h) => /(^|\.)google\.[a-z.]+$/.test(h), pools: ["google"] },
  { why: "Instagram/X", match: (_c, h) => hostIs(h, "instagram.com", "x.com", "twitter.com"), pools: ["geonode-rotating"] },
  // Marketplaces BR: ISP real (Rio/SP) primeiro.
  { why: "Amazon/Carrefour/Enjoei", match: (_c, h) => /(^|\.)(amazon|carrefour|enjoei)\./.test(h), pools: ["isp-high", "geonode-sticky"] },
  { why: "default (browser)", match: () => true, pools: ["geonode-sticky"] },
];

export function poolsFor(ctx: RouteCtx): { why: string; pools: Pool[] } {
  let host = "", path = "/";
  try {
    const u = new URL(ctx.url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch { /* URL inválida: cai no default */ }
  const r = POLICY.find((x) => x.match(ctx, host, path))!;
  return { why: r.why, pools: r.pools };
}

export interface Resolved {
  proxy: { server: string; username?: string; password?: string };
  pool: Pool;
  /** IP ISP estático (== host do proxy) quando pool é isp-*; usado no gate e no cooldown. */
  ispIp?: string;
  /** host:porta para log (sem credenciais). */
  label: string;
}

/** Primeiro pool da política com proxy disponível; undefined => o chamador falha fechado. */
export async function resolveBrowserProxy(ctx: RouteCtx & { region?: string }): Promise<Resolved | undefined> {
  const country = (ctx.region ?? inferCountryFromUrl(ctx.url)).toUpperCase();
  const domain = new URL(ctx.url).hostname.replace(/^www\./, "");
  for (const pool of poolsFor(ctx).pools) {
    if (pool === "isp-high" || pool === "isp-low") {
      if (country !== "BR") continue; // todos os ISPs são BR
      const isp = await pickIsp(pool === "isp-high" ? "high" : "low", domain);
      if (isp) return { proxy: ispToProxyOption(isp), pool, ispIp: isp.ip, label: maskProxy(isp) };
      continue;
    }
    if (pool === "google") {
      const px = getApprovedProxy(GOOGLE_COUNTRY_KEY);
      if (px) return { proxy: px, pool, label: maskProxy(px) };
      continue;
    }
    // Sticky/rotativo: país do alvo, cidade só se pedida. hard => BR (Shopee).
    const cc = ctx.hard ? "BR" : country;
    const px = getApprovedProxy(cc, ctx.city, { sticky: pool === "geonode-sticky" });
    if (px) return { proxy: px, pool, label: maskProxy(px) };
  }
  return undefined;
}
