# MarkUDown-Engine — Arquitetura e Referência

**Gerado:** 2026-08-15
**Stack:** Node.js 20 + TypeScript (ESM, `module: NodeNext`) + BullMQ + Redis
**Papel:** worker de execução. Não expõe API pública — consome filas alimentadas pelo `api/` (Python/FastAPI).

Documentação gerada a partir da leitura direta do código (`src/queues/`, `src/jobs/`, `src/engine/`), não de memória.

> **Correção ao CLAUDE.md:** o arquivo descreve este serviço como *"FastAPI markdown extraction worker"* rodando na porta 8080. Está errado — é **Node/TypeScript com BullMQ**, sem servidor HTTP de API. Há apenas um health check (`HEALTH_PORT`, padrão 3003) e o dashboard Bull Board (`DASHBOARD_PORT`, padrão 5555).

---

## Índice

1. [Visão geral do fluxo](#1-visão-geral-do-fluxo)
2. [A escada de fallback](#2-a-escada-de-fallback--o-núcleo-do-produto)
3. [Filas e workers](#3-filas-e-workers)
4. [Formato dos payloads](#4-formato-dos-payloads)
5. [Motores](#5-motores-srcengine)
6. [Playbook Engine](#6-playbook-engine)
7. [Configuração](#7-configuração)
8. [Segurança](#8-segurança)
9. [Testes](#9-testes)
10. [Inconsistências encontradas](#10-inconsistências-encontradas)

---

## 1. Visão geral do fluxo

```
Cliente
  │  POST /api/scrape  (X-API-KEY)
  ▼
api/ (FastAPI)                     ← valida chave, aplica rate limit, cobra créditos
  │  queue_client.add_job("scrape", payload)
  ▼
Redis (BullMQ)
  │
  ▼
MarkUDown-Engine                   ← ESTE SERVIÇO
  │  Worker consome da fila
  │  orchestrator.extract() → escada de fallback
  │  retorna resultado como job result
  ▼
Redis (job result)
  │
  ├─→ Cliente faz GET /api/scrape/{job_id}  (polling)
  └─→ sendWebhook(callback_url)              (push)
```

**Princípio arquitetural (correção C2 da spec do Playbook Engine):** o worker **não tem cliente de banco de dados nem cliente HTTP do api**. É alimentado inteiramente pelo payload do job e devolve o resultado pelo padrão de job result. Quem escreve no Postgres é o `api/`, nunca o worker.

Exceção: os workers de Playbook (`playbook-heal`, `playbook-token-refresh`, `playbook-monitor`) fazem chamadas HTTP de volta ao `api/` autenticadas com `X-Internal-Key` — mas ainda assim nunca tocam Postgres direto.

---

## 2. A escada de fallback — o núcleo do produto

`src/engine/orchestrator.ts` → `extract(url, opts)`

É aqui que mora a proposta de valor: **três camadas com custo crescente, parando na primeira que funciona.**

```
┌─ PDF? ──────────────────────────────────────────────┐
│  isPdfUrl() → fetchPdfAsMarkdown()  → source: "pdf"  │
└─────────────────────────────────────────────────────┘
              │ (não é PDF, ou falhou)
              ▼
┌─ forceAbrasio? ─────────────────────────────────────┐
│  pula direto para a camada 3                        │
└─────────────────────────────────────────────────────┘
              │
              ▼
╔═ CAMADA 1: Cheerio ═════════════════════════════════╗
║  HTTP simples + parse. Custo ~ms.                   ║
║  Pulada se forcePlaywright OU se há `actions`        ║
║  (actions exigem browser).                          ║
║  hasContent(html)? → retorna source: "cheerio"      ║
╚═════════════════════════════════════════════════════╝
              │ conteúdo vazio/fino, ou erro
              ▼
╔═ CAMADA 2: Patchright ══════════════════════════════╗
║  Browser real. Custo ~segundos.                     ║
║  Com actions → confia no resultado sempre           ║
║  Sem actions → exige hasContent()                   ║
║  → retorna source: "playwright"                     ║
╚═════════════════════════════════════════════════════╝
              │ conteúdo vazio (bloqueio silencioso), ou erro
              ▼
╔═ CAMADA 3: Abrasio ═════════════════════════════════╗
║  Browser stealth (fingerprint TLS/JA3/JA4).         ║
║  Só se isAbrasioAvailable().                        ║
║  → retorna source: "abrasio"                        ║
╚═════════════════════════════════════════════════════╝
              │ todas falharam
              ▼
        AllLayersFailedError(url, errors[])
```

**O detalhe que importa:** `hasContent()` detecta **bloqueio silencioso** — quando o site responde 200 mas devolve página vazia/challenge. Sem isso, um WAF que retorna 200 com conteúdo falso passaria como sucesso. É o que dispara a descida para a camada mais cara.

---

## 3. Filas e workers

Declaração: `src/queues/queues.ts` · Registro: `src/queues/workers.ts`

| Fila | Concorrência | Handler | Tipo |
|---|---|---|---|
| `scrape` | `MAX_CONCURRENT_PAGES` (10) | `processScrapeJob` | extração |
| `crawl` | 2 | `processCrawlJob` | extração |
| `map` | 3 | `processMapJob` | descoberta |
| `batch-scrape` | 2 | `processBatchScrapeJob` | extração |
| `screenshot` | 5 | `processScreenshotJob` | captura |
| `rss` | 3 | `processRssJob` | feed |
| `search` | 3 | `processSearchJob` | busca |
| `change-detection` | 5 | `processChangeDetectionJob` | monitoramento |
| `extract` | 3 | `processExtractJob` | IA |
| `deep-research` | 2 | `processDeepResearchJob` | IA |
| `agent` | 2 | `processAgentJob` | IA |
| `smart-extract` | 2 | `processSmartExtractJob` | IA |
| `rank` | 5 | `processRankJob` | SERP |
| `dataset` | 2 | `processDatasetJob` | IA |
| `monitor` | 10 | `processMonitorJob` | agendador |
| `instagram` | 3 | `processInstagramJob` | social ⚠️ |
| `x` | 3 | `processXJob` | social ⚠️ |
| `playbook` | 5 | `processPlaybookJob` | replay |
| `playbook-monitor` | 10 | `processPlaybookMonitorJob` | agendador |
| `playbook-heal` | 2 | `processPlaybookHealJob` | self-heal |
| `playbook-token-refresh` | 5 | `processPlaybookTokenRefreshJob` | refresh |

**Total: 21 workers.**

⚠️ `instagram` e `x` têm workers registrados mas **não estão declaradas em `queues.ts`** nem em `allQueues` — ver [seção 10](#10-inconsistências-encontradas).

### Opções de retenção

`defaultOpts` em `queues.ts`: `{ removeOnComplete: 1000, removeOnFail: 5000 }`

As filas de playbook usam retenção mais curta, definida no lado do `api/` (`_PLAYBOOK_JOB_OPTS = {removeOnComplete: 50, removeOnFail: 200}`) — porque seus payloads carregam segredos selados, e retenção indefinida seria exposição desnecessária.

---

## 4. Formato dos payloads

Convenção geral: `{ url, options: {...} }`. Todos com `options` opcional.

### `scrape`
```ts
{
  url: string;
  options?: {
    timeout?: number; exclude_tags?: string[]; main_content?: boolean;
    include_link?: boolean; include_html?: boolean;
    force_playwright?: boolean;   // pula camada 1
    force_abrasio?: boolean;      // vai direto pra camada 3
    actions?: PageAction[];       // exige browser
    wait_until?: "domcontentloaded" | "load" | "networkidle";
    cache?: CacheOptions;
    formats?: ("markdown" | "summary")[];
    summary_language?: string;
    abrasio?: AbrasioOptions;
  };
}
```

### `crawl`
```ts
{
  url: string;
  options?: {
    max_depth?: number; limit?: number; timeout?: number;
    include_link?: boolean; include_html?: boolean; exclude_tags?: string[];
    blocked_words?: string[]; include_only?: string[];
    allowed_patterns?: string[]; blocked_patterns?: string[];
    main_content?: boolean; concurrency?: number;
  };
}
```

### `map`
```ts
{ url: string; options?: { allowed_words?: string[]; blocked_words?: string[]; max_urls?: number } }
```

### `extract`
```ts
{
  url: string;
  schema?: Record<string, string>;
  prompt?: string;
  extraction_scope?: string; extraction_target?: string; extract_query?: string;
  options?: { timeout?: number; main_content?: boolean };
}
```

### `search`
```ts
{
  query: string;
  options?: {
    limit?: number; timeout?: number; include_html?: boolean;
    scrape_results?: boolean; lang?: string; country?: string;
    engine?: SearchEngine;   // google | bing | duckduckgo | all
  };
}
```

### `dataset`
```ts
{
  url: string; goal: string;
  schema?: Record<string, string>;
  options?: { max_pages?: number; timeout?: number; output_format?: "json" | "csv" };
}
```

### Webhook (`callback_url`)

`src/utils/webhooks.ts` → `sendWebhook(webhook, payload)`. **Fire-and-forget: nunca lança, apenas loga.**

```jsonc
{
  "event": "completed" | "failed",
  "queue": "scrape",
  "jobId": "...",
  "data": {},          // se completed
  "error": "...",      // se failed
  "brokeAtIndex": 0,   // playbook: onde quebrou
  "brokeStep": {},     // playbook: qual step quebrou
  "timestamp": "2026-08-15T..."
}
```

Timeout de 10s. Headers customizados via `webhook.headers`.

---

## 5. Motores (`src/engine/`)

| Arquivo | Papel |
|---|---|
| `orchestrator.ts` | Escada de fallback (seção 2). Ponto de entrada de toda extração. |
| `cheerio-engine.ts` | Camada 1 — HTTP + parse, sem browser |
| `playwright-engine.ts` | Camada 2 — Patchright, com suporte a `actions` |
| `abrasio-engine.ts` | Camada 3 — browser stealth via `abrasio-sdk` |
| `extraction-planner.ts` | Planeja extração via LLM (`/plan/` do python-llm) |
| `structure-analyzer.ts` | Analisa estrutura da página |
| `site-analyzer.ts` | Análise de site para dataset/crawl |
| `guided-executor.ts` | Execução guiada de passos |
| `playbook-runner.ts` | Replay determinístico de playbook (T0/T1/T2) |
| `playbook-heal.ts` | Propõe correção via LLM quando playbook quebra |
| `secrets-box.ts` | AES-256-GCM seal/open, interoperável com Python |

### `secrets-box.ts` — formato do envelope

Deve casar **byte a byte** com `api/app/security/secrets_box.py`:

```
cipher    : AES-256-GCM
key       : base64decode(PLAYBOOK_SECRET_KEY) → 32 bytes crus
nonce     : 12 bytes aleatórios por seal
aad       : nenhum
plaintext : JSON UTF-8 do objeto de segredos
blob      : nonce(12) ‖ ciphertext ‖ tag(16)
string    : base64 padrão do blob
```

Node: `getAuthTag()` são os 16 bytes finais. Python: `AESGCM.encrypt` devolve `ciphertext‖tag`, com nonce prefixado.

---

## 6. Playbook Engine

### `playbook-runner.ts` — os três tiers

| Tier | `transport` | Caminho | Latência |
|---|---|---|---|
| **T0** | `http` | `StealthClient` (fingerprint TLS), sem browser | ~ms |
| **T1** | `http_render` | HTTP + Cheerio, extração por seletor CSS | ~dezenas de ms |
| **T2** | `browser` | Abrasio, executa steps com primitivas Playwright | ~segundos |

**T0 é o caminho quente.** Descobre-se o feed interno do site uma vez (durante RECORD) e replica por HTTP puro depois. Usa `StealthClient` do `abrasio-sdk` porque alvos protegidos (ex: bet365) devolvem 403 para `fetch` comum independente dos headers.

### Semântica de quebra por tier

| Situação | `reason` | Consequência |
|---|---|---|
| T0 responde 401/403 | `token` | Token morto → dispara **refresh**, não é quebra |
| T0 `response_path` não resolve | `response_shape` | API mudou → dispara **self-heal** |
| T1/T2 seletor não encontrado | `selector` | Site mudou → dispara **self-heal** |

### Validações de segurança no replay

Aplicadas em **todo** replay, não só em propostas de self-heal (correção 2026-08-11):

- **`isAllowedStepUrl(url, domain)`** — protocolo http(s) e host igual ao domínio do playbook ou subdomínio. Aplicado em T0 (`request`), T1 (`navigate`) e T2 (`navigate`).
- **Redirect desabilitado com segredo** — quando um header resolve de `secret_ref:`, usa `allowRedirects: false` / `redirect: "manual"`. Motivo: o undici só remove `host`/`authorization`/`cookie`/`proxy-authorization` em redirect cross-origin — headers arbitrários como `X-Api-Key` seguiriam para o destino.
- **`execTimedRegex`** — `response_pattern` roda em worker thread com timeout de 500ms. A heurística estática de ReDoS não é confiável (`(a|a)*$` passa e trava 27s); o timeout real é a defesa.
- **`clampStepTimeout`** — máximo 120s por step; deadline geral de 5min por run T2.

### `playbook-heal.ts` — validação de proposta

`validateHealProposal(proposedSteps, originalSteps, domain)` roda **antes** de qualquer replay do candidato. Rejeita:

1. Op fora da lista permitida
2. URL fora do domínio ou protocolo não-http(s)
3. `evaluate` novo ou modificado (só passa se `script` for byte-idêntico a um já existente no original)
4. `fill` com `secret_ref` sem procedência — o par `(selector, secret_ref)` precisa existir no original
5. `scroll.pixels` fora de ±100.000 ou não-inteiro
6. `timeout` fora de (0, 120.000]
7. `response_pattern` com formato perigoso ou regex inválida
8. Mais de 50 steps

Depois disso, o candidato é **verificado por replay real** antes de persistir. Só então é postado como versão+1.

### Fluxo de self-heal

```
/ingest recebe failed(selector|response_shape)
  → api: _maybe_trigger_heal (guard rails: 2 tentativas/hora/grupo, lock por domínio 120s)
  → fila playbook-heal
  → worker: coleta evidência (transport-específico)
  → proposeHeal() → python-llm /plan/
  → validateHealProposal()          ← rejeita antes de executar
  → runPlaybook(candidato)          ← verifica de verdade
  → POST /playbooks/{id}/versions   ← só se verificou
```

---

## 7. Configuração

`src/config.ts` — validado com Zod, falha no boot se inválido.

| Variável | Padrão | Papel |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | BullMQ |
| `GO_MD_SERVICE_URL` | `http://localhost:3001` | Serviço Go de markdown |
| `PYTHON_LLM_URL` | `http://localhost:3002` | Serviço LLM |
| `SCRAPETECH_API_URL` | `http://localhost:8000` | Callback para o api |
| `ABRASIO_API_URL` | `""` | Vazio = Abrasio desabilitado |
| `ABRASIO_API_KEY` | `""` | — |
| `GENAI_API_KEY` | `""` | — |
| `INTERNAL_SERVICE_KEY` | `""` | Auth serviço-a-serviço |
| `PLAYBOOK_SECRET_KEY` | *(via `process.env`)* | Chave AES-256 base64 (32 bytes) |
| `DASHBOARD_USERNAME` / `_PASSWORD` | `""` | Basic Auth do Bull Board |
| `PROXY_URL` / `_USERNAME` / `_PASSWORD` | `""` | Proxy |
| `HEALTH_PORT` | `3003` | Health check (0 = desabilita) |
| `DASHBOARD_PORT` | `5555` | Bull Board |
| `HEADLESS` | `true` | `false` abre janela (dev) |
| `DEFAULT_TIMEOUT` | `60` | segundos |
| `MAX_CONCURRENT_PAGES` | `10` | Concorrência do worker `scrape` |
| `MAX_CRAWL_DEPTH` | `5` | — |
| `MAX_CRAWL_URLS` | `1000` | — |

Se `INTERNAL_SERVICE_KEY` estiver vazio, o config loga erro no boot (correção 2026-08-11) — antes falhava silenciosamente com 401 em toda persistência.

`PLAYBOOK_SECRET_KEY` é lido via `process.env` cru em `secrets-box.ts`, **não está no schema Zod** — falha tarde, no primeiro uso, em vez de no boot.

---

## 8. Segurança

### Dashboard Bull Board

`src/dashboard.ts`. Antes de 2026-08-11 não tinha autenticação alguma e renderizava `job.data` de todas as filas — incluindo, à época, segredos em texto plano.

Agora:
- **Basic Auth** com comparação timing-safe (`timingSafeEqual`)
- **Sem credenciais configuradas → bind em `127.0.0.1`** apenas, falha fechado em vez de expor à rede

### Segredos nos payloads

Os jobs de playbook recebem `secrets_enc` **selado**, nunca texto plano. Cada handler abre em memória logo antes do uso via `openSecrets()` e nunca reescreve o valor aberto de volta em `job.data`.

Antes da correção, o `api/` abria os segredos e enfileirava em texto plano — que o BullMQ persistia no Redis indefinidamente, anulando toda a criptografia em repouso.

### `X-Internal-Key` nos webhooks

Não trafega mais em `job.data`. O worker anexa a partir do próprio config quando reconhece que o `callback_url` é do api:

```ts
new URL(callbackUrl).origin === new URL(config.SCRAPETECH_API_URL).origin
```

Comparação de **origin**, não `startsWith` — a primeira versão usava prefixo e `https://internal.example.attacker.example` passava.

---

## 9. Testes

```bash
npx tsc --noEmit    # typecheck
npx vitest run      # testes
npm run build       # tsc → dist/  (o que o CI/Docker roda)
```

**Baseline conhecido: 176 passam / 2 falham.** As 2 falhas são pré-existentes e não relacionadas:
- `tests/config.test.ts > "Abrasio defaults to disabled"` — depende do `.env` local
- `src/jobs/instagram.test.ts > "parses a single cookie"` — formato de cookie mudou

⚠️ **Rode `rm -rf dist` antes do vitest** se tiver acabado de buildar — o vitest coleta os `.test.js` compilados em `dist/` e reporta falhas duplicadas/falsas.

---

## 10. Inconsistências encontradas

### 10.1 Filas `instagram` e `x` invisíveis no dashboard
`workers.ts:47-48` registra os workers e `api/app/queue_client.py:230-235` despacha para elas, mas **não há `new Queue("instagram")` nem `new Queue("x")` em `queues.ts`**, nem entrada em `allQueues`.

**Consequência:** não aparecem no Bull Board. Jobs rodam normalmente (o Worker abre a própria conexão; o objeto `Queue` só é necessário para enfileirar pelo Node, e quem enfileira é o Python), mas não há visibilidade operacional.

**Correção:** adicionar as duas filas em `queues.ts` e em `allQueues`.

### 10.2 `PLAYBOOK_SECRET_KEY` fora do schema Zod
Lido via `process.env` cru em `secrets-box.ts:29`. Falha no primeiro uso em vez de no boot. Deveria estar em `config.ts` como as demais.

### 10.3 Duplicação pré-existente em `monitor.ts`
`monitor.ts` abre conexão Redis nova a cada tick e instancia `Queue` local sem `removeOnComplete`. Foi deliberadamente **não corrigido** — é código de produção com clientes pagantes, e `playbook-monitor.ts` foi escrito espelhando seu padrão de propósito. Corrigir exige tocar em `monitor.ts`.

### 10.4 CLAUDE.md descreve o serviço errado
Diz "FastAPI markdown extraction worker" na porta 8080. É Node/TypeScript + BullMQ, sem API HTTP.
