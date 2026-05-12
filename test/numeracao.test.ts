import { describe, it, expect } from "vitest";
import {
  inferNumeracao,
  faseAbrev,
  buildPlaceholderName,
  numeracaoSequencial,
  parseNome,
  derivarFaseAbrevDosNomes,
  fasesPresentesNosDados,
} from "../src/processar/numeracao";

describe("faseAbrev", () => {
  it("mapeia as fases conhecidas", () => {
    expect(faseAbrev("captação")).toBe("CAP");
    expect(faseAbrev("aquecimento")).toBe("AQUEC");
    expect(faseAbrev("lembrete/comprometimento")).toBe("LEMB");
    expect(faseAbrev("contagem regressiva")).toBe("REGRE");
    expect(faseAbrev("avisos")).toBe("AVI");
    expect(faseAbrev("grupo vip")).toBe("VIP");
  });
  it("é case/whitespace-insensitive", () => {
    expect(faseAbrev("  Captação ")).toBe("CAP");
  });
  it("fase desconhecida devolve null", () => {
    expect(faseAbrev("outra coisa")).toBeNull();
  });
});

describe("buildPlaceholderName", () => {
  it("arma AD<N>-<FASE>-<SUFIJO_TIPO> com o sufixo certo (CAR -> EST-CARR)", () => {
    expect(buildPlaceholderName(13, "CAP", "VID")).toBe("AD13-CAP-VID");
    expect(buildPlaceholderName(3, "LEMB", "EST")).toBe("AD3-LEMB-EST");
    expect(buildPlaceholderName(6, "AQUEC", "CAR")).toBe("AD6-AQUEC-EST-CARR");
  });
});

describe("numeracaoSequencial", () => {
  it("gera N nomes consecutivos a partir de `desde`", () => {
    expect(numeracaoSequencial(13, 3, "CAP", "VID")).toEqual([
      "AD13-CAP-VID",
      "AD14-CAP-VID",
      "AD15-CAP-VID",
    ]);
    expect(numeracaoSequencial(2, 2, "LEMB", "CAR")).toEqual([
      "AD2-LEMB-EST-CARR",
      "AD3-LEMB-EST-CARR",
    ]);
  });
});

describe("parseNome", () => {
  it("reconhece placeholder de vídeo e estático plano", () => {
    expect(parseNome("AD13-CAP-VID")).toEqual({
      formato: "placeholder",
      faseAbr: "CAP",
      tipo: "VID",
      n: 13,
    });
    expect(parseNome("AD3-LEMB-EST")).toEqual({
      formato: "placeholder",
      faseAbr: "LEMB",
      tipo: "EST",
      n: 3,
    });
  });
  it("reconhece as 4 partes de AD<N>-<FASE>-EST-CARR (carrossel, não EST)", () => {
    expect(parseNome("AD6-AQUEC-EST-CARR")).toEqual({
      formato: "placeholder",
      faseAbr: "AQUEC",
      tipo: "CAR",
      n: 6,
    });
    expect(parseNome("AD2-LEMB-EST-CARR")).toEqual({
      formato: "placeholder",
      faseAbr: "LEMB",
      tipo: "CAR",
      n: 2,
    });
  });
  it("reconhece o formato de arquivo finalizado L<leva>-<TIPO>-AD<N>-V<v>-<FASE>", () => {
    expect(parseNome("L1-VID-AD54-V1-CAP")).toEqual({
      formato: "arquivo",
      faseAbr: "CAP",
      tipo: "VID",
      n: 54,
    });
    expect(parseNome("L1-CAR-AD8-V1-AQUEC")).toEqual({
      formato: "arquivo",
      faseAbr: "AQUEC",
      tipo: "CAR",
      n: 8,
    });
  });
  it("devolve null para NOMEs que não reconhece", () => {
    expect(parseNome("qualquer coisa")).toBeNull();
    expect(parseNome("AD5-CAP-LOQUESEA")).toBeNull();
    expect(parseNome("")).toBeNull();
  });
});

describe("fasesPresentesNosDados", () => {
  // linhas = filas existentes (linha×coluna); iFase = índice da col FASE no header.
  const headers = ["FASE", "NOME"];
  const iFase = headers.indexOf("FASE");
  it("devolve as fases distintas não vazias da col FASE, na ordem de aparição", () => {
    const linhas = [
      ["captação", "AD13-CAP-VID"],
      ["captação", "AD14-CAP-VID"],
      ["aquecimento", "AD2-AQUEC-EST"],
      ["", "AD9-???-VID"],
    ];
    expect(fasesPresentesNosDados(linhas, iFase)).toEqual(["captação", "aquecimento"]);
  });
  it("aba sem dados -> []", () => {
    expect(fasesPresentesNosDados([], iFase)).toEqual([]);
  });
  it("col FASE inexistente (índice -1) -> []", () => {
    expect(fasesPresentesNosDados([["x", "y"]], -1)).toEqual([]);
  });
  it("normaliza maiúsc/espaços para deduplicar, mas devolve a primeira grafia vista", () => {
    const linhas = [
      ["  Captação ", "AD1-CAP-VID"],
      ["captação", "AD2-CAP-VID"],
    ];
    expect(fasesPresentesNosDados(linhas, iFase)).toEqual(["Captação"]);
  });
});

describe("derivarFaseAbrevDosNomes", () => {
  const headers = ["FASE", "NOME"];
  const iFase = headers.indexOf("FASE");
  const iNome = headers.indexOf("NOME");
  it("deriva a abreviação correlacionando col FASE com o NOME placeholder", () => {
    const linhas = [
      ["captação", "AD13-CAP-VID"],
      ["captação", "AD14-CAP-VID"],
      ["aquecimento", "AD2-AQUEC-EST"],
    ];
    expect(derivarFaseAbrevDosNomes(linhas, iFase, iNome, "captação")).toBe("CAP");
    expect(derivarFaseAbrevDosNomes(linhas, iFase, iNome, "aquecimento")).toBe("AQUEC");
  });
  it("ignora filas de arquivo finalizado e NOMEs não reconhecidos", () => {
    const linhas = [
      ["captação", "L1-VID-AD54-V1-CAP"], // arquivo: não conta
      ["captação", "lixo qualquer"], // não parseável
      ["captação", "AD3-CAP-VID"], // este sim
    ];
    expect(derivarFaseAbrevDosNomes(linhas, iFase, iNome, "captação")).toBe("CAP");
  });
  it("fase sem nenhuma fila placeholder de onde derivar -> null", () => {
    const linhas = [["aquecimento", "AD1-AQUEC-VID"]];
    expect(derivarFaseAbrevDosNomes(linhas, iFase, iNome, "captação")).toBeNull();
  });
  it("colunas inexistentes -> null", () => {
    expect(derivarFaseAbrevDosNomes([["x"]], -1, 0, "captação")).toBeNull();
    expect(derivarFaseAbrevDosNomes([["x"]], 0, -1, "captação")).toBeNull();
  });
});

describe("inferNumeracao", () => {
  // nomesExistentes = a coluna NOME completa da aba (todas as filas, todas as fases).
  it("continua a partir do max das filas placeholder da mesma fase+tipo", () => {
    const nomes = ["AD11-CAP-VID", "AD12-CAP-VID", "AD5-AQUEC-EST-CARR"];
    expect(inferNumeracao(nomes, "captação", "VID", 3)).toEqual({
      ambiguo: false,
      desde: 13,
      nomes: ["AD13-CAP-VID", "AD14-CAP-VID", "AD15-CAP-VID"],
    });
  });
  it("IGNORA as filas de arquivo finalizado (L<leva>-...) — usam outro contador", () => {
    // L1-VID-AD20-V1-CAP é CAP+VID com N=20, mas é arquivo finalizado: não conta.
    const nomes = ["AD11-CAP-VID", "AD12-CAP-VID", "L1-VID-AD54-V1-CAP", "L1-VID-AD20-V1-CAP"];
    expect(inferNumeracao(nomes, "captação", "VID", 2)).toEqual({
      ambiguo: false,
      desde: 13,
      nomes: ["AD13-CAP-VID", "AD14-CAP-VID"],
    });
  });
  it("distingue carrossel (EST-CARR) de estático plano (EST) na mesma fase", () => {
    const nomes = ["AD2-LEMB-EST-CARR", "AD3-LEMB-EST", "L1-EST-AD1-V1-LEMB"];
    // próximo carrossel de lembrete -> 3 (max placeholder EST-CARR = 2)
    expect(inferNumeracao(nomes, "lembrete/comprometimento", "CAR", 1)).toEqual({
      ambiguo: false,
      desde: 3,
      nomes: ["AD3-LEMB-EST-CARR"],
    });
    // próximo estático plano de lembrete -> 4 (max placeholder EST = 3)
    expect(inferNumeracao(nomes, "lembrete/comprometimento", "EST", 1)).toEqual({
      ambiguo: false,
      desde: 4,
      nomes: ["AD4-LEMB-EST"],
    });
  });
  it("sem precedente placeholder dessa fase+tipo -> ambiguo", () => {
    const nomes = ["AD11-CAP-VID"]; // não há nenhum EST de captação
    expect(inferNumeracao(nomes, "captação", "EST", 2)).toEqual({ ambiguo: true });
  });
  it("só há arquivos finalizados dessa fase+tipo (nenhum placeholder) -> ambiguo", () => {
    const nomes = ["L1-VID-AD54-V1-CAP", "L1-VID-AD55-V1-CAP"];
    expect(inferNumeracao(nomes, "captação", "VID", 1)).toEqual({ ambiguo: true });
  });
  it("fase desconhecida -> ambiguo", () => {
    expect(inferNumeracao(["AD1-CAP-VID"], "fase rara", "VID", 1)).toEqual({ ambiguo: true });
  });
});
