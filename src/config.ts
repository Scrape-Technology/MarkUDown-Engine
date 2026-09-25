import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  REDIS_URL: z.string().default("redis://localhost:6379"),
  GO_MD_SERVICE_URL: z.string().default("http://localhost:3001"),
  PYTHON_LLM_URL: z.string().default("http://localhost:3002"),

  // The Scrape Technology FastAPI service (CLAUDE.md: api/, port 8000) — used by the
  // playbook-monitor scheduler (spec 2026-07-15, item 3) to trigger runs via
  // POST /api/playbooks/by-group/{group_id}/run, authenticated with INTERNAL_SERVICE_KEY.
  SCRAPETECH_API_URL: z.string().default("http://localhost:8000"),

  // Abrasio (proprietary stealth engine) — empty = disabled
  ABRASIO_API_URL: z.string().default(""),
  ABRASIO_API_KEY: z.string().default(""),

  // LLM
  GENAI_API_KEY: z.string().default(""),

  // Internal auth key sent to the python-llm service — must match INTERNAL_SERVICE_KEY there
  INTERNAL_SERVICE_KEY: z.string().default(""),

  PROXY_URL: z.string().default(""),
  PROXY_USERNAME: z.string().default(""),
  // IPRoyal ISP estáticos (aprovados): CSV `host:port:user:pass` (porta 12323 HTTP), separados
  // por vírgula/;/quebra de linha. host == IP de saída. NUNCA logar user/pass. Ver
  // src/utils/proxy-pool.ts. IPROYAL_ISP_META (JSON opcional) = {"<ip>":{"city":"..","trust":"high|low"}}
  // sobrescreve os metadados padrão.
  IPROYAL_ISP_PROXIES: z.string().default(""),
  IPROYAL_ISP_META: z.string().default(""),
  // Gate de prontidão: após criar a sessão Abrasio com proxy e ANTES de navegar ao alvo,
  // confirma o túnel com um eco de IP (api.ipify.org) — falha fechado se não subir em ~20s.
  PROXY_READINESS_GATE: z
    .string()
    .default("true")
    .transform((v) => !["false", "0", "no", "off"].includes(v.trim().toLowerCase())),
  // Sticky endpoint of the SAME provider/credentials (Geonode: port 10000 keeps one exit IP;
  // the rotating :9000 in PROXY_URL changes IP per connection). BROWSER sessions (Abrasio,
  // dataset Patchright) use it when set: a page loads HTML + JS + XHRs over many connections,
  // and a mid-page IP change trips Cloudflare / breaks hydration (Enjoei returned 0 items on
  // :9000, 35 on :10000). Single-request clients (Cheerio) stay on PROXY_URL. Empty = fall back
  // to PROXY_URL.
  PROXY_STICKY_URL: z.string().default(""),
  PROXY_PASSWORD: z.string().default(""),

  // Dedicated proxy for google.* — a datacenter egress IP (ECS) gets an immediate
  // "unusual traffic" CAPTCHA wall from Google regardless of target country, so the
  // general PROXY_URL/country-suffix scheme doesn't apply here. Needs a sticky
  // residential session (confirmed 2026-08-19: Geonode's rotating port 9000 changes
  // exit IP per connection and also gets blocked — port 10000 holds one IP for the
  // session and works). Falls back to no proxy (direct) when unset.
  GOOGLE_PROXY_URL: z.string().default(""),
  GOOGLE_PROXY_USERNAME: z.string().default(""),
  GOOGLE_PROXY_PASSWORD: z.string().default(""),

  // Regra de egress (CEO, 2026-09): TODA requisição a site alvo sai por proxy Geonode; nada
  // sai pelo IP da máquina/ECS do worker. true (padrão) = fail-closed: sem proxy aplicável a
  // requisição FALHA com EgressPolicyError. false só para dev local (log de aviso alto).
  // Chamadas internas (python-llm, chassi API, Redis, Go markdown) não entram. Ver
  // src/utils/egress.ts.
  REQUIRE_PROXY_EGRESS: z
    .string()
    .default("true")
    .transform((v) => !["false", "0", "no", "off"].includes(v.trim().toLowerCase())),

  // Pool `hard` do Abrasio (home server, ex. Shopee). Decisão do CEO (2026-09): NÃO é mais
  // exceção — não pode queimar o IP residencial de casa; deve sair por Geonode sticky BR.
  // Porém o worker do home pool (StandaloneManager em abrasio/server_entrypoint.py) tem
  // `#proxy=client_proxy` COMENTADO: o `proxy` da sessão é recebido e logado, mas NÃO aplicado
  // (o worker ECS aplica). Sem prova de que o home aplica, o padrão é FALHAR FECHADO (false).
  // true só depois de o worker home aplicar o proxy (ou como aceite consciente do risco).
  // Ver abrasioEgressFor() em src/utils/egress.ts.
  EGRESS_HARD_HOME_ALLOWED: z
    .string()
    .default("false")
    .transform((v) => !["false", "0", "no", "off"].includes(v.trim().toLowerCase())),

  // Health-check HTTP port (0 = disabled)
  HEALTH_PORT: z.coerce.number().default(3003),

  // Bull Board dashboard auth (bug found in review, 2026-08-11: the dashboard rendered
  // every queue's job.data verbatim — including, before this same review, playbook
  // secrets and the internal service key — with NO auth at all; anyone who could reach
  // the port saw live credentials). Empty = no credentials configured, in which case
  // dashboard.ts binds to localhost only rather than every interface.
  DASHBOARD_USERNAME: z.string().default(""),
  DASHBOARD_PASSWORD: z.string().default(""),

  // Browser mode — set HEADLESS=false to open a visible window (local dev only)
  HEADLESS: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  // Scraping defaults
  DEFAULT_TIMEOUT: z.coerce.number().default(60),
  MAX_CONCURRENT_PAGES: z.coerce.number().default(10),
  MAX_CRAWL_DEPTH: z.coerce.number().default(5),
  MAX_CRAWL_URLS: z.coerce.number().default(1000),
  // Per-domain throttle: caps how many extract() calls (any job type, any
  // layer) may be in flight against the SAME target domain at once, across
  // the whole worker fleet (Redis-backed, not per-process) — existing
  // concurrency limits are per QUEUE (job type), with no cross-queue
  // awareness that a scrape/extract/crawl job might all be hitting the same
  // site simultaneously. See src/utils/domain-throttle.ts.
  MAX_CONCURRENT_PER_DOMAIN: z.coerce.number().default(4),

  // Domains that must be routed straight to Abrasio's home-server worker pool
  // (hard=True) instead of the normal Layer 1/2 ladder — sites hard enough to
  // need a persistent logged-in session that only exists on the home server
  // (e.g. Shopee). Comma-separated hostnames or parent domains (a request to
  // any subdomain matches too). See src/utils/hard-route.ts.
  HARD_ROUTE_DOMAINS: z.string().default("shopee.com.br,shopee.com"),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;

// Bug found in review, 2026-08-11: INTERNAL_SERVICE_KEY defaults to "" and several
// callers (playbook-heal.ts, playbook-token-refresh.ts, playbook-monitor.ts) send it
// unconditionally with no startup check — unlike llm-fetch.ts, which guards with an
// `if`. A misconfigured deploy would silently send an empty internal-auth header on
// every persist/trigger call, each rejected 401 by the api with nothing logging why.
// Loud at import time instead of silent at request time (mirrors the same fix on the
// api side, api/app/routes/playbooks.py).
if (!config.INTERNAL_SERVICE_KEY) {
  // eslint-disable-next-line no-console
  console.error(
    "INTERNAL_SERVICE_KEY is not set — every Playbook Engine self-heal persist, " +
    "token-refresh persist, and monitor trigger will be rejected 401 by the api.",
  );
}
