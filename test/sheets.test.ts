import { describe, it, expect, vi, afterEach } from "vitest";

// Mockeamos obterAccessToken: este test prueba el armado de las requests a la
// Sheets API y el parseo de las respuestas, no la auth.
vi.mock("../src/google/auth", () => ({
  obterAccessToken: vi.fn(async () => "TOKEN_FALSO"),
}));

import {
  lerHeaders,
  lerFilas,
  escreverFilas,
  acharFilaInicio,
  listarTitulosAbas,
} from "../src/google/sheets";

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

describe("acharFilaInicio", () => {
  // iColA=0 (FASE), iColB=1 (NOME) — discriminador típico
  it("devuelve la primera fila vacía consecutiva cuando hay un bloque suficiente", () => {
    // filas[0]=row2 con datos, filas[1..]=row3+ vacías. cantidad=3 cabe arrancando en row3.
    const filas = [
      ["captação", "AD1-CAP-VID"],
      [], // row 3 vazia
      [], // row 4 vazia
      [], // row 5 vazia
      ["captação", "AD2-CAP-VID"], // row 6 con datos
    ];
    expect(acharFilaInicio(filas, 0, 1, 3)).toBe(3);
  });

  it("salta filas que tienen FASE o NOME (= 'parte de la data' aunque otras cols estén vacías)", () => {
    const filas = [
      ["captação", "AD1-CAP-VID"], // row 2: dados
      ["captação", "AD2-CAP-VID"], // row 3: dados
      ["captação", "AD3-CAP-VID"], // row 4: dados
      [], // row 5: vacía
      [], // row 6: vacía
    ];
    expect(acharFilaInicio(filas, 0, 1, 2)).toBe(5);
  });

  it("salta bloques vacíos demasiado chicos hasta encontrar uno del tamaño pedido", () => {
    const filas = [
      [], // row 2 vazia (bloque de 1)
      ["captação", "AD1-CAP-VID"], // row 3: dados (rompe)
      [], // row 4 vazia
      [], // row 5 vazia
      [], // row 6 vazia (bloque de 3, cabe cantidad=3)
    ];
    expect(acharFilaInicio(filas, 0, 1, 3)).toBe(4);
  });

  it("considera vazia uma row mesmo se há texto em outra coluna (não FASE/NOME)", () => {
    const filas = [
      ["", "", "valor en col C"], // row 2: A y B vacías -> vazia desde nossa ótica
      ["", "", ""], // row 3 vazia
    ];
    expect(acharFilaInicio(filas, 0, 1, 2)).toBe(2);
  });

  it("fallback: si no hay bloque suficiente, devuelve la fila siguiente al último dato", () => {
    const filas = [
      ["captação", "AD1-CAP-VID"], // row 2: dados
      ["captação", "AD2-CAP-VID"], // row 3: dados
      [], // row 4: vazia
    ];
    // Pido 5 filas pero solo hay 1 vacía -> fallback = última con dados + 1 = 4
    expect(acharFilaInicio(filas, 0, 1, 5)).toBe(4);
  });

  it("Sheet completamente vacía (solo header) -> escribe en row 2", () => {
    expect(acharFilaInicio([], 0, 1, 3)).toBe(2);
  });

  it("Sheet só com ghost-rows (toda fila vazia en A/B) -> escribe en row 2", () => {
    const filas = [[], [], [], [], []];
    expect(acharFilaInicio(filas, 0, 1, 3)).toBe(2);
  });

  it("trabaja con iColA/iColB no necesariamente 0/1 (header en otras posiciones)", () => {
    // Imaginar headers donde FASE está en col índice 2 y NOME en 3
    const filas = [
      ["", "", "captação", "AD1-CAP-VID"], // tiene dados en 2/3 -> no vazia
      ["", "", "", ""], // vazia em 2/3
    ];
    expect(acharFilaInicio(filas, 2, 3, 1)).toBe(3);
  });
});

describe("escreverFilas", () => {
  it("hace PUT a values.update con USER_ENTERED y range A<inicio>:K<fin>", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const u = decodeURIComponent(url);
      expect(u).toContain(`/values/'${ABA}'!A6:C7`);
      expect(url).toContain("valueInputOption=USER_ENTERED");
      expect(url).not.toContain("insertDataOption"); // PUT/update, no append
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({
        values: [
          ["captação", "AD4-CAP-VID", "aberto"],
          ["captação", "AD5-CAP-VID", "aberto"],
        ],
      });
      return respostaJson({
        updatedRange: "'03. ADS NOVOS'!A6:C7",
        updatedRows: 2,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await escreverFilas(env, SHEET, ABA, 6, [
      ["captação", "AD4-CAP-VID", "aberto"],
      ["captação", "AD5-CAP-VID", "aberto"],
    ]);
    expect(res).toEqual({ updatedRange: "'03. ADS NOVOS'!A6:C7", updatedRows: 2 });
  });

  it("calcula la letra de la columna final correctamente (11 cols -> K)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(decodeURIComponent(url)).toContain(`/values/'${ABA}'!A6:K6`);
      return respostaJson({ updatedRange: "'X'!A6:K6", updatedRows: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await escreverFilas(env, SHEET, ABA, 6, [["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]]);
  });

  it("devolve {updatedRows: 0} sem chamar fetch quando valores está vazio", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await escreverFilas(env, SHEET, ABA, 6, []);
    expect(res).toEqual({ updatedRows: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lanza si la API devuelve error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    await expect(escreverFilas(env, SHEET, ABA, 6, [["x"]])).rejects.toThrow(/403/);
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
