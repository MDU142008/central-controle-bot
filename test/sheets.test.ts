import { describe, it, expect, vi, afterEach } from "vitest";

// Mockeamos obterAccessToken: este test prueba el armado de las requests a la
// Sheets API y el parseo de las respuestas, no la auth.
vi.mock("../src/google/auth", () => ({
  obterAccessToken: vi.fn(async () => "TOKEN_FALSO"),
}));

import { lerHeaders, lerFilas, appendFilas, listarTitulosAbas } from "../src/google/sheets";

const env = { GOOGLE_SERVICE_ACCOUNT_JSON: "{}" } as any;
const SHEET = "1ABC";
const ABA = "03. ADS NOVOS"; // nombre con espacios + punto + arranca con dígito -> necesita comillas en A1

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respostaJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("lerHeaders", () => {
  it("pide 'aba'!1:1 (con comillas en A1) y devuelve la primera fila, manteniendo vacíos del medio", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = decodeURIComponent(url);
      expect(u).toContain(`/spreadsheets/${SHEET}/values/'${ABA}'!1:1`);
      return respostaJson({
        values: [["FASE", "NOME", "COPY", "", "DESIGN OU EDIÇÃO", "", "STATUS"]],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const headers = await lerHeaders(env, SHEET, ABA);
    expect(headers).toEqual(["FASE", "NOME", "COPY", "", "DESIGN OU EDIÇÃO", "", "STATUS"]);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: "Bearer TOKEN_FALSO" },
    });
  });

  it("devuelve [] si la aba no tiene fila 1", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respostaJson({})));
    expect(await lerHeaders(env, SHEET, ABA)).toEqual([]);
  });

  it("lanza si la API responde con error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    await expect(lerHeaders(env, SHEET, ABA)).rejects.toThrow(/400/);
  });
});

describe("lerFilas", () => {
  it("pide 'aba'!A2:ZZ y devuelve las filas (pueden tener largo distinto)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(decodeURIComponent(url)).toContain(`/values/'${ABA}'!A2:ZZ`);
      return respostaJson({
        values: [
          ["captação", "AD13-CAP-VID", "aberto"],
          ["captação", "AD14-CAP-VID"],
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const filas = await lerFilas(env, SHEET, ABA);
    expect(filas).toEqual([
      ["captação", "AD13-CAP-VID", "aberto"],
      ["captação", "AD14-CAP-VID"],
    ]);
  });

  it("devuelve [] si la aba no tiene datos", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respostaJson({})));
    expect(await lerFilas(env, SHEET, ABA)).toEqual([]);
  });
});

describe("appendFilas", () => {
  it("hace POST a :append con USER_ENTERED + INSERT_ROWS y el body {values}, devuelve updatedRange/updatedRows", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const u = decodeURIComponent(url);
      expect(u).toContain(`/values/'${ABA}'!A1:append`);
      expect(url).toContain("valueInputOption=USER_ENTERED");
      expect(url).toContain("insertDataOption=INSERT_ROWS");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        values: [["captação", "AD15-CAP-VID", "aberto"]],
      });
      return respostaJson({
        updates: { updatedRange: "'03. ADS NOVOS'!A1007:K1007", updatedRows: 1 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await appendFilas(env, SHEET, ABA, [["captação", "AD15-CAP-VID", "aberto"]]);
    expect(res).toEqual({ updatedRange: "'03. ADS NOVOS'!A1007:K1007", updatedRows: 1 });
  });

  it("lanza si el append falla", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    await expect(appendFilas(env, SHEET, ABA, [["x"]])).rejects.toThrow(/403/);
  });
});

describe("listarTitulosAbas", () => {
  it("hace GET ?fields=sheets.properties.title y devuelve los títulos en orden", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = decodeURIComponent(url);
      expect(u).toContain(`/spreadsheets/${SHEET}?fields=sheets.properties.title`);
      return respostaJson({
        sheets: [
          { properties: { title: "00. Links importantes" } },
          { properties: { title: "03. ADS NOVOS" } },
          { properties: { title: "04. ADS REAP" } },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const titulos = await listarTitulosAbas(env, SHEET);
    expect(titulos).toEqual(["00. Links importantes", "03. ADS NOVOS", "04. ADS REAP"]);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: "Bearer TOKEN_FALSO" },
    });
  });

  it("filtra entradas sem title (ignora propriedades vazias)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respostaJson({
          sheets: [{ properties: { title: "A" } }, { properties: {} }, {}],
        }),
      ),
    );
    expect(await listarTitulosAbas(env, SHEET)).toEqual(["A"]);
  });

  it("devuelve [] si la respuesta no trae sheets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respostaJson({})));
    expect(await listarTitulosAbas(env, SHEET)).toEqual([]);
  });

  it("lanza si la API responde con error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    await expect(listarTitulosAbas(env, SHEET)).rejects.toThrow(/403/);
  });
});
