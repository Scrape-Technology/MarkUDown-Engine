import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    PROXY_URL: "http://proxy.example.test:9000",
    PROXY_USERNAME: "user-type-residential-country-",
    PROXY_PASSWORD: "p@ss",
    GOOGLE_PROXY_URL: "", GOOGLE_PROXY_USERNAME: "", GOOGLE_PROXY_PASSWORD: "",
  },
}));

import {
  normalizeCity, getPlaywrightProxyForCountry, getProxyUrlForCountryCity, getProxyUrlForUrl,
} from "./proxy-region.js";

describe("normalizeCity", () => {
  it("aceita slug ascii minusculo e normaliza caixa", () => {
    expect(normalizeCity("saopaulo")).toBe("saopaulo");
    expect(normalizeCity(" SaoPaulo ")).toBe("saopaulo");
  });
  it.each(["sao paulo", "sao_paulo", "sao-paulo", "são", "a", "", "x;y", "a".repeat(41), undefined, 3])("rejeita %j", (v) => {
    expect(normalizeCity(v)).toBeUndefined();
  });
});

describe("montagem do proxy por pais/cidade", () => {
  it("sem cidade: comportamento atual (sufixo de pais minusculo)", () => {
    expect(getPlaywrightProxyForCountry("BR")).toEqual({
      server: "http://proxy.example.test:9000", username: "user-type-residential-country-br", password: "p@ss",
    });
  });
  it("com cidade: acrescenta -city-<slug>", () => {
    expect(getPlaywrightProxyForCountry("BR", "saopaulo")?.username).toBe("user-type-residential-country-br-city-saopaulo");
  });
  it("cidade invalida e ignorada (nunca entra no username)", () => {
    expect(getPlaywrightProxyForCountry("BR", "sao_paulo;drop")?.username).toBe("user-type-residential-country-br");
  });
  it("URL com credenciais escapadas", () => {
    expect(getProxyUrlForCountryCity("BR", "saopaulo")).toBe(
      "http://user-type-residential-country-br-city-saopaulo:p%40ss@proxy.example.test:9000",
    );
  });
  it("country invalido nao gera proxy", () => {
    expect(getProxyUrlForCountryCity("BRA", "saopaulo")).toBeUndefined();
  });
  it("override de pais sobrepoe a TLD (.com -> BR) e sem override mantem US", () => {
    expect(getProxyUrlForUrl("https://www.facebook.com/x", "BR")).toContain("country-br:");
    expect(getProxyUrlForUrl("https://www.facebook.com/x")).toContain("country-us:");
  });
});
