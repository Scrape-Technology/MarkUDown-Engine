// src/utils/proxy-pool.ts
//
// Pool de proxies ISP ESTÁTICOS da IPRoyal (aprovados pelo CEO) + estado adaptativo:
// round-robin, cooldown por bloqueio e teto por IP/domínio. Quem escolhe QUANDO usar o pool é
// proxy-policy.ts; aqui só se escolhe QUAL IP.
//
// Estado em Redis (cliente fail-fast de redis.ts) com fallback em memória do processo quando
// o Redis está indisponível — o pool nunca trava um job por causa do Redis.
//   proxy:rr:<trust>            contador de round-robin
//   proxy:cooldown:<ip>         existe => IP em cooldown (TTL COOLDOWN_SECONDS)
//   proxy:cap:<ip>:<domínio>    contador de navegações na janela (TTL CAP_WINDOW_SECONDS)
//
// SEGURANÇA: user/pass nunca são logados. Logue só `maskProxy()` (host:porta).
//
// Sessões logadas (hoje NÃO existe nenhuma nossa): um IP ISP NUNCA pode ser compartilhado entre
// sessões logadas de domínios diferentes — quando existirem, prender o IP ao domínio (chave
// proxy:bind:<ip> = domínio) e excluí-lo de pickIsp() para os demais.

import { config } from "../config.js";
import { logger } from "./logger.js";
import { createRedisClient } from "./redis.js";

export type IspTrust = "high" | "low";

export interface IspProxy {
  ip: string; // host == IP de saída (estático)
  port: number;
  username: string;
  password: string;
  city: string;
  trust: IspTrust;
}

/** Cooldown após sinal de bloqueio atribuível ao IP. */
export const COOLDOWN_SECONDS = 15 * 60;
/**
 * Teto de NAVEGAÇÕES por IP ISP por domínio na janela. ISPs estáticos não rotacionam: passar de
 * um ritmo humano num mesmo domínio queima o IP. 120/h ≈ 1 página a cada 30 s. Uma sessão
 * reserva as navegações que pretende fazer (pickIsp `navigations`); extras de um crawl entram
 * via countIspNavigation().
 */
export const CAP_PER_IP_PER_DOMAIN = 120;
export const CAP_WINDOW_SECONDS = 3600;

// Metadados MEDIDOS por eco (ipwho.is, 2026-09-24). Irecê = M247 (hosting => provável
// classificação datacenter => trust low); Rio (ML Telecom) e SP (Octet Brasil) = ISP real.
const DEFAULT_META: Record<string, { city: string; trust: IspTrust }> = {
  "144.225.28.108": { city: "irece", trust: "low" },
  "144.225.31.185": { city: "irece", trust: "low" },
  "144.225.1.118": { city: "irece", trust: "low" },
  "144.225.0.224": { city: "irece", trust: "low" },
  "200.239.236.34": { city: "riodejaneiro", trust: "high" },
  "200.239.237.19": { city: "riodejaneiro", trust: "high" },
  "200.160.36.84": { city: "saopaulo", trust: "high" },
  "200.160.34.235": { city: "saopaulo", trust: "high" },
};

/** Parse `host:port:user:pass[,...]`. Entradas inválidas são ignoradas (sem ecoar o conteúdo). */
export function parseIspPool(csv: string, metaJson = ""): IspProxy[] {
  let meta: Record<string, { city?: string; trust?: string }> = {};
  if (metaJson.trim()) {
    try {
      meta = JSON.parse(metaJson);
    } catch {
      logger.warn("IPROYAL_ISP_META inválido (JSON) — usando metadados padrão");
    }
  }
  const out: IspProxy[] = [];
  for (const raw of csv.split(/[,;\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const [host, port, username, ...rest] = entry.split(":");
    const password = rest.join(":");
    if (!host || !/^\d{2,5}$/.test(port ?? "") || !username || !password) continue;
    const m = { ...DEFAULT_META[host], ...meta[host] } as { city?: string; trust?: string };
    out.push({
      ip: host,
      port: Number(port),
      username,
      password,
      city: m.city ?? "desconhecida",
      // Desconhecido => low (conservador: só serve ao Ad Library, onde o IP é descartável).
      trust: m.trust === "high" ? "high" : "low",
    });
  }
  return out;
}

let _pool: IspProxy[] | null = null;
export function getIspPool(): IspProxy[] {
  return (_pool ??= parseIspPool(config.IPROYAL_ISP_PROXIES, config.IPROYAL_ISP_META));
}
/** Só para testes. */
export function _resetIspPool(): void {
  _pool = null;
  memCooldown.clear();
  memCap.clear();
  memRr.clear();
  _redisDownUntil = 0;
  _redis = null;
}

/** host:porta — nunca credenciais. */
export function maskProxy(p: { ip?: string; port?: number; server?: string }): string {
  if (p.ip) return `${p.ip}:${p.port ?? ""}`;
  return (p.server ?? "").replace(/\/\/[^@/]*@/, "//");
}

export function ispToProxyOption(p: IspProxy): { server: string; username: string; password: string } {
  return { server: `http://${p.ip}:${p.port}`, username: p.username, password: p.password };
}

// ── Estado: Redis com fallback em memória ─────────────────────────────────────

const memCooldown = new Map<string, number>(); // ip -> expira em ms
const memCap = new Map<string, { n: number; exp: number }>();
const memRr = new Map<string, number>();

let _redis: Awaited<ReturnType<typeof createRedisClient>> | null = null;
// Redis fora => usa só memória por 60 s antes de tentar de novo (evita pagar o timeout a cada chamada).
let _redisDownUntil = 0;
async function redis() {
  if (Date.now() < _redisDownUntil) return null;
  try {
    return (_redis ??= await createRedisClient());
  } catch {
    _redisDownUntil = Date.now() + 60_000;
    return null;
  }
}
/** Executa `fn` no Redis; qualquer erro => undefined (o chamador cai na memória). */
async function withRedis<T>(fn: (r: NonNullable<Awaited<ReturnType<typeof redis>>>) => Promise<T>): Promise<T | undefined> {
  const r = await redis();
  if (!r) return undefined;
  try {
    return await fn(r);
  } catch {
    _redisDownUntil = Date.now() + 60_000;
    // Após o retryStrategy desistir (null), o ioredis nunca mais reconecta: descarta o cliente
    // para que a próxima janela crie um novo em vez de reusar um morto para sempre.
    if (_redis === r) {
      _redis = null;
      r.disconnect();
    }
    return undefined;
  }
}

export async function isCoolingDown(ip: string): Promise<boolean> {
  const viaRedis = await withRedis((r) => r.exists(`proxy:cooldown:${ip}`));
  if (viaRedis !== undefined) return viaRedis === 1;
  return (memCooldown.get(ip) ?? 0) > Date.now();
}

/** Sinal de bloqueio atribuível ao proxy (captcha/403/429/thin-blocked): IP em cooldown. */
export async function markIpBlocked(ip: string): Promise<void> {
  memCooldown.set(ip, Date.now() + COOLDOWN_SECONDS * 1000); // sempre também em memória
  await withRedis((r) => r.set(`proxy:cooldown:${ip}`, "1", "EX", COOLDOWN_SECONDS));
  logger.warn("Proxy ISP em cooldown após sinal de bloqueio", { ip, minutes: COOLDOWN_SECONDS / 60 });
}

async function nextRr(trust: string): Promise<number> {
  const viaRedis = await withRedis((r) => r.incr(`proxy:rr:${trust}`));
  if (viaRedis !== undefined) return viaRedis;
  const n = (memRr.get(trust) ?? 0) + 1;
  memRr.set(trust, n);
  return n;
}

// INCRBY + TTL atômicos (Lua: funciona em qualquer Redis; EXPIRE NX exige 7.0). Sem isso uma
// queda entre INCR e EXPIRE deixava a chave sem TTL — teto eterno para aquele IP/domínio.
const CAP_LUA =
  "local n = redis.call('INCRBY', KEYS[1], ARGV[1]) " +
  "if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end return n";

/** Domínio usado na chave do teto (sem www.). */
export function capDomain(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** Conta `units` navegações para (ip, domínio); devolve true se ainda está dentro do teto. */
async function withinCap(ip: string, domain: string, units = 1): Promise<boolean> {
  const key = `proxy:cap:${ip}:${domain}`;
  const viaRedis = await withRedis(async (r) => Number(await r.eval(CAP_LUA, 1, key, units, CAP_WINDOW_SECONDS)));
  if (viaRedis !== undefined) return viaRedis <= CAP_PER_IP_PER_DOMAIN;
  const now = Date.now();
  const cur = memCap.get(key);
  const e = cur && cur.exp > now ? cur : { n: 0, exp: now + CAP_WINDOW_SECONDS * 1000 };
  e.n += units;
  memCap.set(key, e);
  return e.n <= CAP_PER_IP_PER_DOMAIN;
}

/** Navegação extra numa sessão ISP já aberta (crawl multi-URL): entra no teto do IP/domínio. */
export async function countIspNavigation(ip: string, domain: string): Promise<void> {
  await withinCap(ip, domain, 1);
}

/**
 * Próximo IP ISP do nível `trust` para `domain`, em round-robin, pulando IPs em cooldown ou
 * acima do teto. A escolha RESERVA `navigations` unidades do teto (o teto conta navegações,
 * não sessões: um dataset de N páginas reserva N). undefined => nenhum disponível (Geonode).
 */
export async function pickIsp(trust: IspTrust, domain: string, navigations = 1): Promise<IspProxy | undefined> {
  const units = Math.max(1, Math.floor(navigations) || 1);
  const candidates = getIspPool().filter((p) => p.trust === trust);
  if (!candidates.length) return undefined;
  const start = await nextRr(trust);
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[(start + i) % candidates.length];
    if (await isCoolingDown(p.ip)) continue;
    if (!(await withinCap(p.ip, domain, units))) continue;
    return p;
  }
  return undefined;
}
