import { describe, it, expect } from "vitest";
import {
  extractWithSelectors, assessPlanQuality, absolutizeLinkFields, normalizeCountry, toAbsoluteUrl,
  type SelectorPlan,
} from "./dataset-extract.js";

const schema = { title: "titulo", price: "preco", url: "URL absoluta do anuncio" };

describe("extractWithSelectors - URLs absolutas", () => {
  const html = `<div class="card"><a class="lnk" href="/Nome/dp/B0ABC/ref=sr_1_1"><span class="t">Body</span></a><img class="im" src="//cdn.x.com/a.jpg"></div>`;
  const plan: SelectorPlan = {
    item_container: ".card",
    fields: {
      title: { selector: ".t", attr: null },
      url: { selector: "a.lnk", attr: "href" },
      image: { selector: "img.im", attr: "src" },
    },
    pagination_next: null,
  };
  it("resolve href/src relativos contra a URL da pagina", () => {
    const [item] = extractWithSelectors(html, plan, "https://www.amazon.com.br/s?k=example-brand");
    expect(item.url).toBe("https://www.amazon.com.br/Nome/dp/B0ABC/ref=sr_1_1");
    expect(item.image).toBe("https://cdn.x.com/a.jpg");
    expect(item.title).toBe("Body");
  });
  it("respeita base href", () => {
    const [item] = extractWithSelectors(`<base href="https://b.com/root/">${html}`, plan, "https://www.amazon.com.br/s");
    expect(item.url).toBe("https://b.com/Nome/dp/B0ABC/ref=sr_1_1");
  });
  it("sem baseUrl mantem o valor original", () => {
    expect(extractWithSelectors(html, plan)[0].url).toBe("/Nome/dp/B0ABC/ref=sr_1_1");
  });
  it("nao mexe em javascript: e mailto:", () => {
    expect(toAbsoluteUrl("javascript:void(0)", "https://a.com")).toBe("javascript:void(0)");
    expect(toAbsoluteUrl("mailto:a@b.c", "https://a.com")).toBe("mailto:a@b.c");
  });
});

describe("extractWithSelectors - container e o proprio elemento", () => {
  const html = `<a class="c-product-card" href="/p/body-example-brand-123"><span class="ttl">Body Example Product</span><span class="prc">R$ 40</span></a>
                <a class="c-product-card" href="/p/top-example-brand-456"><span class="ttl">Top</span><span class="prc">R$ 25</span></a>`;
  const base = "https://www.enjoei.com.br/s?q=example-brand";
  it("seletor igual ao container casa o proprio elemento", () => {
    const plan: SelectorPlan = {
      item_container: "a.c-product-card",
      fields: { title: { selector: ".ttl", attr: null }, url: { selector: "a.c-product-card", attr: "href" } },
      pagination_next: null,
    };
    const items = extractWithSelectors(html, plan, base);
    expect(items.map((i) => i.url)).toEqual([
      "https://www.enjoei.com.br/p/body-example-brand-123", "https://www.enjoei.com.br/p/top-example-brand-456",
    ]);
  });
  it.each(["", ":scope", "&"])("seletor %j significa o proprio container", (sel) => {
    const plan: SelectorPlan = {
      item_container: "a.c-product-card",
      fields: { url: { selector: sel, attr: "href" } },
      pagination_next: null,
    };
    expect(extractWithSelectors(html, plan, base)[0].url).toBe("https://www.enjoei.com.br/p/body-example-brand-123");
  });
  it("href lido do proprio container quando o seletor aponta um filho sem href", () => {
    const plan: SelectorPlan = {
      item_container: "a.c-product-card",
      fields: { url: { selector: ".ttl", attr: "href" } },
      pagination_next: null,
    };
    expect(extractWithSelectors(html, plan, base)[1].url).toBe("https://www.enjoei.com.br/p/top-example-brand-456");
  });
  it("seletor invalido nao lanca (campo null)", () => {
    const plan: SelectorPlan = { item_container: "a.c-product-card", fields: { x: { selector: "[[bad", attr: null } }, pagination_next: null };
    expect(extractWithSelectors(html, plan, base)[0].x).toBeNull();
  });
  it("comportamento antigo preservado (descendentes)", () => {
    const plan: SelectorPlan = { item_container: "a.c-product-card", fields: { title: { selector: ".ttl", attr: null } }, pagination_next: null };
    expect(extractWithSelectors(html, plan)[0].title).toBe("Body Example Product");
  });
});

describe("assessPlanQuality", () => {
  const plan: SelectorPlan = { item_container: ".c", fields: { title: { selector: ".t", attr: null }, url: { selector: "a", attr: "href" } }, pagination_next: null };
  const mk = (n: number, url: (i: number) => unknown) => Array.from({ length: n }, (_, i) => ({ title: `t${i}`, price: "1", url: url(i) }));

  it("valido com links distintos", () => {
    expect(assessPlanQuality(mk(60, (i) => `https://a.com/p/${i}`), schema, plan).valid).toBe(true);
  });
  it("(a) url vazio em todos os 60 (caso Amazon) e invalido", () => {
    const v = assessPlanQuality(mk(60, () => null), schema, plan);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/url/);
  });
  it("(a) 50% ou mais vazios invalida; menos de 50% passa", () => {
    expect(assessPlanQuality(mk(10, (i) => (i < 5 ? "" : `https://a.com/${i}`)), schema, plan).valid).toBe(false);
    expect(assessPlanQuality(mk(10, (i) => (i < 4 ? "" : `https://a.com/${i}`)), schema, plan).valid).toBe(true);
  });
  it("(b) mesmo link generico em 59 itens (caso Mercado Livre) e invalido", () => {
    const v = assessPlanQuality(mk(59, () => "https://www.mercadolivre.com.br/anuncios"), schema, plan);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/distinct/);
  });
  it("lista pequena (<5) com poucos links distintos nao e penalizada", () => {
    expect(assessPlanQuality(mk(4, () => "https://a.com/x"), schema, plan).valid).toBe(true);
    expect(assessPlanQuality(mk(3, (i) => (i === 0 ? "https://a.com/x" : "")), schema, plan).valid).toBe(true);
    expect(assessPlanQuality(mk(1, () => null), schema, plan).valid).toBe(true);
  });
  it("lista pequena com TODOS os links vazios (>=3) e invalida", () => {
    expect(assessPlanQuality(mk(3, () => null), schema, plan).valid).toBe(false);
  });
  it("5 itens com 2 links distintos passa; 5 itens com 1 falha", () => {
    expect(assessPlanQuality(mk(5, (i) => `https://a.com/${i % 2}`), schema, plan).valid).toBe(true);
    expect(assessPlanQuality(mk(5, () => "https://a.com/1"), schema, plan).valid).toBe(false);
  });
  it("sem campo de link no schema nao e penalizado", () => {
    const p: SelectorPlan = { item_container: ".c", fields: { title: { selector: ".t", attr: null }, price: { selector: ".p", attr: null } }, pagination_next: null };
    const items = Array.from({ length: 30 }, () => ({ title: "same", price: "1" }));
    expect(assessPlanQuality(items, { title: "t", price: "p" }, p).valid).toBe(true);
  });
  it("campo de imagem repetido nao conta como link", () => {
    const p: SelectorPlan = { item_container: ".c", fields: { image_url: { selector: "img", attr: "src" } }, pagination_next: null };
    const items = Array.from({ length: 30 }, () => ({ image_url: "https://a.com/placeholder.gif" }));
    expect(assessPlanQuality(items, { image_url: "URL da imagem" }, p).valid).toBe(true);
  });
  it("descricao link em campo neutro conta", () => {
    const p: SelectorPlan = { item_container: ".c", fields: { anuncio: { selector: "a", attr: "href" } }, pagination_next: null };
    const items = Array.from({ length: 10 }, () => ({ anuncio: null }));
    expect(assessPlanQuality(items, { anuncio: "link do anuncio" }, p).valid).toBe(false);
  });
});

describe("absolutizeLinkFields (saida do LLM)", () => {
  it("resolve so campos de link com caminho relativo", () => {
    const out = absolutizeLinkFields(
      [{ title: "/nao-mexer", url: "/p/abc", image_url: "/img.png" }, { url: "https://x.com/ok" }],
      { title: "t", url: "URL", image_url: "URL da imagem" },
      "https://www.enjoei.com.br/s?q=x",
    );
    expect(out[0]).toEqual({ title: "/nao-mexer", url: "https://www.enjoei.com.br/p/abc", image_url: "/img.png" });
    expect(out[1].url).toBe("https://x.com/ok");
  });
});

describe("normalizeCountry", () => {
  it("aceita 2 letras, normaliza caixa, rejeita o resto", () => {
    expect(normalizeCountry("BR")).toBe("BR");
    expect(normalizeCountry("br")).toBe("BR");
    for (const bad of ["BRA", "B", "1A", "", undefined, 5, "B R"]) expect(normalizeCountry(bad)).toBeUndefined();
  });
});
