import { describe, it, expect } from "vitest";
import { normalizarTituloAba, resolverAbaAdsNovos } from "../src/processar/aba";

describe("normalizarTituloAba", () => {
  it.each([
    ["03. ADS NOVOS", "ads novos"],
    ["3 ads novos", "ads novos"],
    ["Ads Novos", "ads novos"],
    ["03 - Ads novos", "ads novos"],
    ["03.ADS NOVOS", "ads novos"],
    ["ADS_NOVOS", "ads novos"],
    ["  03.  Ads  Novos  ", "ads novos"],
    ["ÁDS NOVÔS", "ads novos"], // strip acentos
    ["04. ADS REAP", "ads reap"], // não bate com "ads novos"
    ["ADS NOVOS 2026", "ads novos 2026"], // sufixo extra: não bate
    ["07. Mensagens grupos", "mensagens grupos"],
    ["", ""],
  ])("normaliza %j -> %j", (entrada, esperado) => {
    expect(normalizarTituloAba(entrada)).toBe(esperado);
  });
});

describe("resolverAbaAdsNovos", () => {
  it("acha 03. ADS NOVOS entre outras abas reais", () => {
    const titulos = [
      "00. Links importantes",
      "01. Pesquisas/forms",
      "02. Páginas",
      "03. ADS NOVOS",
      "04. ADS REAP",
      "05. CPLs",
      "06. Email",
      "07. Mensagens grupos",
      "08. Mensagens grupo VIP",
      "09. Lista de espera",
    ];
    expect(resolverAbaAdsNovos(titulos)).toEqual({ tipo: "achou", titulo: "03. ADS NOVOS" });
  });

  it("acha variações de nome (preserva o título exato pra ler/escrever)", () => {
    for (const variante of ["3 ads novos", "Ads Novos", "03 - Ads novos", "ADS_NOVOS"]) {
      const titulos = ["00. Links", variante, "04. ADS REAP"];
      expect(resolverAbaAdsNovos(titulos)).toEqual({ tipo: "achou", titulo: variante });
    }
  });

  it("não confunde com ads reap nem outras abas (devolve nenhuma)", () => {
    const titulos = ["04. ADS REAP", "06. Email", "07. Mensagens grupos"];
    expect(resolverAbaAdsNovos(titulos)).toEqual({ tipo: "nenhuma" });
  });

  it("nenhuma quando a Sheet não tem abas", () => {
    expect(resolverAbaAdsNovos([])).toEqual({ tipo: "nenhuma" });
  });

  it("varias quando há mais de uma aba que matchea (raríssimo, mas pede escolha)", () => {
    const titulos = ["03. ADS NOVOS", "Ads Novos"];
    expect(resolverAbaAdsNovos(titulos)).toEqual({
      tipo: "varias",
      candidatos: ["03. ADS NOVOS", "Ads Novos"],
    });
  });
});
