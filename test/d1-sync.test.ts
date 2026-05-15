import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Mock de obterAccessToken — testes de sync exercitam o request shape e o
// upsert no D1, não a auth.
vi.mock("../src/google/auth", () => ({
  obterAccessToken: vi.fn(async () => "TOKEN_FALSO"),
}));

import {
  parseBoolFlexivel,
  filaParaAdRow,
  filaEhVazia,
  sincronizarAdsNovos,
  type SyncEnv,
} from "../src/d1/sync";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const HEADERS = [
  "FASE",
  "NOME",
  "COPY",
  "", // LINK COPY (sub-coluna)
  "DESIGN OU EDIÇÃO",
  "",
  "STATUS",
  "RESPONSÁVEL",
  "LINK ADS FINALIZADO",
  "REVISÃO FINAL",
  "GESTOR DE ADS RECEBEU",
];

describe("parseBoolFlexivel", () => {
  it.each([
    ["TRUE", 1],
    ["true", 1],
    ["1", 1],
    ["Verdadeiro", 1],
    ["Sim", 1],
    ["FALSE", 0],
    ["false", 0],
    ["0", 0],
    ["Não", 0],
    ["Falso", 0],
    ["No", 0],
  ])("normaliza %j -> %j", (entrada, esperado) => {
    expect(parseBoolFlexivel(entrada)).toBe(esperado);
  });

  it("devolve null para vazio ou ambíguo", () => {
    expect(parseBoolFlexivel("")).toBeNull();
    expect(parseBoolFlexivel("   ")).toBeNull();
    expect(parseBoolFlexivel("talvez")).toBeNull();
    expect(parseBoolFlexivel("abc")).toBeNull();
  });
});

describe("filaParaAdRow", () => {
  it("mapeia uma fila típica de 03. ADS NOVOS pra AdRow (LINK COPY = col após COPY)", () => {
    const fila = [
      "captação",
      "AD13-CAP-VID",
      "aberto",
      "Cópia de 1. Criativos de Captação - primeira Leva", // LINK COPY
      "Edição de vídeo",
      "",
      "aberto",
      "Sergio",
      "",
      "FALSE",
      "FALSE",
    ];
    const row = filaParaAdRow(HEADERS, fila, "03. ADS NOVOS", 6);
    expect(row).toEqual({
      source_aba: "03. ADS NOVOS",
      source_row: 6,
      fase: "captação",
      nome: "AD13-CAP-VID",
      copy_status: "aberto",
      link_copy: "Cópia de 1. Criativos de Captação - primeira Leva",
      design_ou_edicao: "Edição de vídeo",
      status: "aberto",
      responsavel: "Sergio",
      link_ads_finalizado: null,
      revisao_final: 0,
      gestor_de_ads_recebeu: 0,
    });
  });

  it("checkboxes em TRUE viram 1", () => {
    const fila = [
      "captação",
      "AD1-CAP-VID",
      "aprovado",
      "Doc roteiro",
      "Edição de vídeo",
      "",
      "finalizado",
      "Sergio",
      "L1-VID-AD1-V1-CAP.mp4",
      "TRUE",
      "TRUE",
    ];
    const row = filaParaAdRow(HEADERS, fila, "03. ADS NOVOS", 3);
    expect(row.revisao_final).toBe(1);
    expect(row.gestor_de_ads_recebeu).toBe(1);
    expect(row.link_ads_finalizado).toBe("L1-VID-AD1-V1-CAP.mp4");
  });

  it("fila com fila[i] undefined em campos do meio -> null no AdRow", () => {
    const fila = ["captação", "AD2-CAP-VID"]; // só A e B preenchidos
    const row = filaParaAdRow(HEADERS, fila, "03. ADS NOVOS", 4);
    expect(row.fase).toBe("captação");
    expect(row.nome).toBe("AD2-CAP-VID");
    expect(row.copy_status).toBeNull();
    expect(row.link_copy).toBeNull();
    expect(row.responsavel).toBeNull();
    expect(row.revisao_final).toBeNull();
  });

  it("tolera ordem de headers diferente (busca por nome, não posição)", () => {
    const headersOutraOrdem = ["NOME", "FASE", "STATUS", "RESPONSÁVEL"];
    const row = filaParaAdRow(headersOutraOrdem, ["AD3-CAP-VID", "captação", "aberto", "Sergio"], "ABA", 5);
    expect(row.nome).toBe("AD3-CAP-VID");
    expect(row.fase).toBe("captação");
    expect(row.status).toBe("aberto");
    expect(row.responsavel).toBe("Sergio");
  });
});

describe("filaEhVazia", () => {
  const base = {
    source_aba: "X",
    source_row: 2,
    fase: null,
    nome: null,
    copy_status: null,
    link_copy: null,
    design_ou_edicao: null,
    status: null,
    responsavel: null,
    link_ads_finalizado: null,
    revisao_final: null,
    gestor_de_ads_recebeu: null,
  };

  it("col A e B vazias -> vazia", () => {
    expect(filaEhVazia(base)).toBe(true);
  });

  it("só FASE -> não vazia", () => {
    expect(filaEhVazia({ ...base, fase: "captação" })).toBe(false);
  });

  it("só NOME -> não vazia", () => {
    expect(filaEhVazia({ ...base, nome: "AD1-CAP-VID" })).toBe(false);
  });

  it("outra coluna preenchida mas A e B vazias -> SIM vazia (consistente com acharFilaInicio)", () => {
    expect(filaEhVazia({ ...base, status: "aberto" })).toBe(true);
  });
});

// --- sincronizarAdsNovos: mock de fetch (Sheets API) + mock de D1 ---

interface MockD1Run {
  sql: string;
  bindings: unknown[];
}

function mockD1(): { db: D1Database; runs: MockD1Run[]; firstResult: unknown } {
  const runs: MockD1Run[] = [];
  let firstResult: unknown = null;
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bindings = args;
          return stmt;
        },
        async run() {
          runs.push({ sql, bindings });
          return { success: true, meta: {} };
        },
        async first<T>() {
          return firstResult as T;
        },
        async all<T>() {
          return { results: [] as T[], success: true, meta: {} };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return {
    db,
    runs,
    get firstResult() {
      return firstResult;
    },
    set firstResult(v: unknown) {
      firstResult = v;
    },
  } as ReturnType<typeof mockD1>;
}

function respostaJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("sincronizarAdsNovos", () => {
  let mock: ReturnType<typeof mockD1>;
  let env: SyncEnv;

  beforeEach(() => {
    mock = mockD1();
    env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
      DB: mock.db,
      SHEET_ID: "1XYZ",
    } as SyncEnv;
  });

  it("end-to-end: descobre aba 'ads novos', lê headers/filas, faz upsert por fila não-vazia + log de sucesso", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = decodeURIComponent(url);
      // 1. listarAbas
      if (u.includes("?fields=sheets.properties(title,sheetId)")) {
        return respostaJson({
          sheets: [
            { properties: { title: "00. Outras", sheetId: 1 } },
            { properties: { title: "03. ADS NOVOS", sheetId: 42 } },
          ],
        });
      }
      // 2. lerHeaders (range 1:1)
      if (u.includes("!1:1")) {
        return respostaJson({ values: [HEADERS] });
      }
      // 3. lerFilas (range A2:ZZ)
      if (u.includes("!A2:ZZ")) {
        return respostaJson({
          values: [
            [
              "captação",
              "AD1-CAP-VID",
              "aberto",
              "Doc roteiro X",
              "Edição de vídeo",
              "",
              "aberto",
              "Sergio",
              "",
              "FALSE",
              "FALSE",
            ],
            ["", "", "", "", "", "", "", "", "", "", ""], // fila vazia -> pulada
            [
              "captação",
              "AD2-CAP-VID",
              "aberto",
              "Doc roteiro X",
              "Edição de vídeo",
              "",
              "aberto",
              "Sergio",
              "",
              "FALSE",
              "FALSE",
            ],
          ],
        });
      }
      throw new Error(`URL inesperada no test: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await sincronizarAdsNovos(env, "teste_d1");

    expect(res.ok).toBe(true);
    expect(res.sourceAba).toBe("03. ADS NOVOS");
    expect(res.rowsSynced).toBe(2); // a fila do meio era vazia

    // 2 upserts + 1 log = 3 statements em D1
    expect(mock.runs).toHaveLength(3);

    // Upserts: AD1 e AD2 (a fila vazia foi pulada)
    expect(mock.runs[0]!.sql).toContain("INSERT INTO ads");
    expect(mock.runs[0]!.bindings[1]).toBe(2); // source_row = i+2; i=0 -> row 2
    expect(mock.runs[0]!.bindings[3]).toBe("AD1-CAP-VID");
    expect(mock.runs[1]!.sql).toContain("INSERT INTO ads");
    expect(mock.runs[1]!.bindings[1]).toBe(4); // i=2 -> row 4 (a fila vazia ocupou row 3)
    expect(mock.runs[1]!.bindings[3]).toBe("AD2-CAP-VID");

    // Log de sucesso
    expect(mock.runs[2]!.sql).toContain("INSERT INTO _sync_log");
    expect(mock.runs[2]!.bindings[1]).toBe("teste_d1"); // trigger
    expect(mock.runs[2]!.bindings[2]).toBe("03. ADS NOVOS"); // source_aba
    expect(mock.runs[2]!.bindings[3]).toBe(2); // rows_synced
    expect(mock.runs[2]!.bindings[4]).toBe("ok"); // status
  });

  it("aba 'ads novos' não achada -> log de erro, ok=false, sem upsert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respostaJson({
          sheets: [{ properties: { title: "00. Outras", sheetId: 1 } }],
        }),
      ),
    );

    const res = await sincronizarAdsNovos(env, "cron");
    expect(res.ok).toBe(false);
    expect(res.sourceAba).toBeNull();
    expect(res.errorMsg).toMatch(/Nenhuma aba/);

    // Só 1 statement em D1: o log de erro
    expect(mock.runs).toHaveLength(1);
    expect(mock.runs[0]!.sql).toContain("INSERT INTO _sync_log");
    expect(mock.runs[0]!.bindings[4]).toBe("error");
  });

  it("erro inesperado (fetch lança) -> ok=false, log best-effort, não re-lança", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("rede caída");
      }),
    );

    const res = await sincronizarAdsNovos(env, "cron");
    expect(res.ok).toBe(false);
    expect(res.errorMsg).toBe("rede caída");
  });
});
