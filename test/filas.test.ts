import { describe, it, expect } from "vitest";
import { tipoToDesignOuEdicao, buildFilasParaSheet } from "../src/processar/filas";

// Headers reais de `03. ADS NOVOS` (de references/sheet-structure.md).
const HEADERS = [
  "FASE",
  "NOME",
  "COPY",
  "",
  "DESIGN OU EDIÇÃO",
  "",
  "STATUS",
  "RESPONSÁVEL",
  "LINK ADS FINALIZADO",
  "REVISÃO FINAL",
  "GESTOR DE ADS RECEBEU",
];

describe("tipoToDesignOuEdicao", () => {
  it("VID -> Edição de vídeo, EST/CAR -> Design", () => {
    expect(tipoToDesignOuEdicao("VID")).toBe("Edição de vídeo");
    expect(tipoToDesignOuEdicao("EST")).toBe("Design");
    expect(tipoToDesignOuEdicao("CAR")).toBe("Design");
  });
});

describe("buildFilasParaSheet", () => {
  it("arma uma fila por ad, mapeada por nome de header (docNome vai na col D = LINK COPY)", () => {
    const filas = buildFilasParaSheet({
      headers: HEADERS,
      fase: "captação",
      ads: [
        { nome: "AD13-CAP-VID", tipo: "VID" },
        { nome: "AD14-CAP-VID", tipo: "VID" },
      ],
      docNome: "1. Criativos de Captação - primeira Leva",
      responsavel: "Sergio",
    });
    expect(filas).toHaveLength(2);
    expect(filas[0]).toEqual([
      "captação",
      "AD13-CAP-VID",
      "aberto",
      "1. Criativos de Captação - primeira Leva",
      "Edição de vídeo",
      "",
      "aberto",
      "Sergio",
      "",
      "FALSE",
      "FALSE",
    ]);
    expect(filas[1]![1]).toBe("AD14-CAP-VID");
  });

  it("estático/carrossel -> DESIGN OU EDIÇÃO = Design", () => {
    const filas = buildFilasParaSheet({
      headers: HEADERS,
      fase: "aquecimento",
      ads: [
        { nome: "AD3-AQUEC-EST-CARR", tipo: "CAR" },
        { nome: "AD4-LEMB-EST", tipo: "EST" },
      ],
      docNome: "2.1 Criativos De Aquecimento Estático",
      responsavel: "Wesley",
    });
    expect(filas[0]![4]).toBe("Design"); // índice de DESIGN OU EDIÇÃO
    expect(filas[1]![4]).toBe("Design");
  });

  it("responsavel vazio deixa a célula vazia (nunca se infere)", () => {
    const filas = buildFilasParaSheet({
      headers: HEADERS,
      fase: "captação",
      ads: [{ nome: "AD13-CAP-VID", tipo: "VID" }],
      docNome: "X",
      responsavel: "",
    });
    expect(filas[0]![7]).toBe(""); // índice de RESPONSÁVEL
  });

  it("a fila tem o mesmo comprimento que os headers e checkboxes em FALSE", () => {
    const filas = buildFilasParaSheet({
      headers: HEADERS,
      fase: "captação",
      ads: [{ nome: "AD13-CAP-VID", tipo: "VID" }],
      docNome: "X",
      responsavel: "Sergio",
    });
    expect(filas[0]).toHaveLength(HEADERS.length);
    expect(filas[0]![9]).toBe("FALSE"); // REVISÃO FINAL
    expect(filas[0]![10]).toBe("FALSE"); // GESTOR DE ADS RECEBEU
  });

  it("tolera ordem de headers diferente (mapeia por nome, não por posição)", () => {
    const headersOutraOrdem = ["NOME", "FASE", "STATUS", "RESPONSÁVEL", "DESIGN OU EDIÇÃO"];
    const filas = buildFilasParaSheet({
      headers: headersOutraOrdem,
      fase: "captação",
      ads: [{ nome: "AD13-CAP-VID", tipo: "VID" }],
      docNome: "X",
      responsavel: "Sergio",
    });
    expect(filas[0]).toEqual(["AD13-CAP-VID", "captação", "aberto", "Sergio", "Edição de vídeo"]);
  });
});
