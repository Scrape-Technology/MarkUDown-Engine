// Varredura estática: nenhum caminho de código pode falar com um alvo sem passar pela
// política de egress (src/utils/egress.ts). Falha se surgir um fetch( / StealthClient /
// contexto de navegador sem proxy fora da allowlist ABAIXO (curta e comentada).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(SRC)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
  .map((f) => ({
    rel: relative(SRC, f).replace(/\\/g, "/"),
    // comentários de linha/bloco fora: mencionar "fetch(" num comentário não é chamada
    text: readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1"),
  }));

/** Texto do "(" em `openIdx` até o ")" correspondente. */
function callBody(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(openIdx, i + 1);
  }
  return text.slice(openIdx);
}
function calls(text: string, re: RegExp): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  for (const m of text.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    out.push({ line: text.slice(0, m.index).split("\n").length, body: callBody(text, open) });
  }
  return out;
}

// `(?<![.\w])` ignora métodos (session.fetch, async fetch); `undici.fetch(` é aceito.
const FETCH_RE = /(?<![.\w])(?<!async )(?:undici\.)?fetch\(/g;

// ── ALLOWLIST de fetch( INTERNO (NÃO é alvo). Curta de propósito: se precisar crescer, a
// chamada provavelmente É um alvo e deve usar proxyAgentFor(). Casa pelo texto da chamada.
const INTERNAL_FETCH: { file: string; includes: string; why: string }[] = [
  { file: "utils/llm-fetch.ts", includes: "PYTHON_LLM_URL", why: "serviço python-llm interno" },
  { file: "processors/markdown-client.ts", includes: "GO_MD_SERVICE_URL", why: "serviço Go de markdown interno" },
  { file: "jobs/playbook-heal.ts", includes: "SCRAPETECH_API_URL", why: "chassi API interna" },
  { file: "jobs/playbook-monitor.ts", includes: "SCRAPETECH_API_URL", why: "chassi API interna" },
  { file: "jobs/playbook-token-refresh.ts", includes: "SCRAPETECH_API_URL", why: "chassi API interna" },
  { file: "utils/webhooks.ts", includes: "webhook.url", why: "callback do cliente (não é alvo de coleta)" },
  { file: "jobs/monitor.ts", includes: "callback_url", why: "callback do cliente (não é alvo de coleta)" },
];

describe("guarda de egress (varredura de src/)", () => {
  it("todo fetch( vai por proxyAgentFor() ou está na allowlist interna", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const c of calls(f.text, FETCH_RE)) {
        const ok =
          c.body.includes("proxyAgentFor(") ||
          INTERNAL_FETCH.some((a) => a.file === f.rel && c.body.includes(a.includes));
        if (!ok) offenders.push(`${f.rel}:${c.line}`);
      }
    }
    expect(offenders, `fetch( a alvo sem proxyAgentFor(): ${offenders.join(", ")}`).toEqual([]);
  });

  it("toda entrada da allowlist ainda casa com uma chamada real (sem lixo velho)", () => {
    for (const a of INTERNAL_FETCH) {
      const f = files.find((x) => x.rel === a.file);
      expect(f, a.file).toBeDefined();
      const hit = calls(f!.text, FETCH_RE).some((c) => c.body.includes(a.includes));
      expect(hit, `${a.file}: ${a.includes}`).toBe(true);
    }
  });

  it("todo new StealthClient( recebe proxy", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const c of calls(f.text, /new StealthClient\(/g)) {
        if (!/\bproxy\b/.test(c.body)) offenders.push(`${f.rel}:${c.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("todo launchPersistentContext( / newContext( aplica proxy", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const c of calls(f.text, /\.(?:launchPersistentContext|newContext)\(/g)) {
        if (!/\bproxy\b/.test(c.body)) offenders.push(`${f.rel}:${c.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("não há chromium.launch( solto nem http/https/net diretos em src/", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (/chromium\.launch\(/.test(f.text)) offenders.push(`${f.rel}: chromium.launch`);
      // src/index.ts usa node:http só para o servidor de health (entrada, não saída).
      if (f.rel !== "index.ts" && /from "(node:)?(https?|net|tls)"/.test(f.text)) offenders.push(`${f.rel}: http/net`);
    }
    expect(offenders).toEqual([]);
  });

  it("os getters crus de proxy-region só são usados por egress.ts", () => {
    const RAW = /\b(getProxyAgentForUrl|getProxyUrlForUrl|getPlaywrightProxyForUrl|getPlaywrightProxyForCountry)\b/;
    const allowed = new Set(["utils/egress.ts", "utils/proxy-region.ts"]);
    const offenders = files.filter((f) => !allowed.has(f.rel) && RAW.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("nenhum lugar cria sessão Abrasio fora de abrasio-engine.ts (que aplica abrasioEgressFor)", () => {
    const offenders = files.filter((f) => f.rel !== "engine/abrasio-engine.ts" && /new Abrasio\(/.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
    const eng = files.find((f) => f.rel === "engine/abrasio-engine.ts")!;
    expect(eng.text).toContain("abrasioEgressFor(");
  });

  it("arquivos novos (ad-library.ts, dataset-extract.ts) não falam com alvo por conta própria", () => {
    for (const rel of ["jobs/ad-library.ts", "jobs/dataset-extract.ts"]) {
      const f = files.find((x) => x.rel === rel)!;
      expect(f, rel).toBeDefined();
      expect(calls(f.text, FETCH_RE), rel).toEqual([]);
      expect(/new Abrasio\(|chromium\.launch\(/.test(f.text), rel).toBe(false);
    }
  });

  it("o pool do Patchright nunca cria a chave NONE por conta própria", () => {
    const pw = files.find((f) => f.rel === "engine/playwright-engine.ts")!;
    expect(pw.text).not.toMatch(/return "NONE"/);
    expect(pw.text).toContain("poolKeyFor(");
  });
});
