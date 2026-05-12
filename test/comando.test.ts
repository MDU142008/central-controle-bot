import { describe, it, expect } from "vitest";
import { parsearArgsProcessar } from "../src/processar/comando";

// Só testamos o parsing dos args de /processar — o resto do handler (Drive,
// Sheets, Sonnet) é I/O e fica para o teste de integração manual (Task 8).

describe("parsearArgsProcessar", () => {
  it("só o link/fileId", () => {
    expect(parsearArgsProcessar("1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18")).toEqual({
      fileIdArg: "1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18",
      responsavel: "",
      desde: null,
      aba: null,
      escrever: false,
    });
  });

  it("link + responsável", () => {
    expect(parsearArgsProcessar("1zZE...id Sergio")).toEqual({
      fileIdArg: "1zZE...id",
      responsavel: "Sergio",
      desde: null,
      aba: null,
      escrever: false,
    });
  });

  it("responsável com espaços (vários tokens)", () => {
    expect(parsearArgsProcessar("https://docs.google.com/d/ID/edit joão v. baima")).toEqual({
      fileIdArg: "https://docs.google.com/d/ID/edit",
      responsavel: "joão v. baima",
      desde: null,
      aba: null,
      escrever: false,
    });
  });

  it("desde:AD<N> — acepta com prefijo AD", () => {
    expect(parsearArgsProcessar("ID Sergio desde:AD13")).toEqual({
      fileIdArg: "ID",
      responsavel: "Sergio",
      desde: 13,
      aba: null,
      escrever: false,
    });
  });

  it("desde:<N> — acepta solo el número", () => {
    expect(parsearArgsProcessar("ID desde:21 Wesley")).toEqual({
      fileIdArg: "ID",
      responsavel: "Wesley",
      desde: 21,
      aba: null,
      escrever: false,
    });
  });

  it("desde: en cualquier posición; el resto es el responsável", () => {
    expect(parsearArgsProcessar("ID desde:5")).toEqual({
      fileIdArg: "ID",
      responsavel: "",
      desde: 5,
      aba: null,
      escrever: false,
    });
  });

  it("args vacíos -> fileIdArg null", () => {
    expect(parsearArgsProcessar("")).toEqual({
      fileIdArg: null,
      responsavel: "",
      desde: null,
      aba: null,
      escrever: false,
    });
    expect(parsearArgsProcessar("   ")).toEqual({
      fileIdArg: null,
      responsavel: "",
      desde: null,
      aba: null,
      escrever: false,
    });
  });

  it("un segundo desde: se trata como parte del responsável (solo el primero cuenta)", () => {
    const r = parsearArgsProcessar("ID desde:1 desde:2");
    expect(r.desde).toBe(1);
    expect(r.responsavel).toBe("desde:2");
  });

  it("--escrever en cualquier posición desactiva el dry-run", () => {
    expect(parsearArgsProcessar("ID --escrever Sergio")).toEqual({
      fileIdArg: "ID",
      responsavel: "Sergio",
      desde: null,
      aba: null,
      escrever: true,
    });
    expect(parsearArgsProcessar("ID Sergio desde:AD13 --escrever")).toEqual({
      fileIdArg: "ID",
      responsavel: "Sergio",
      desde: 13,
      aba: null,
      escrever: true,
    });
  });

  it("aba:<nombre> sobreescribe la aba destino (solo el primero cuenta)", () => {
    expect(parsearArgsProcessar("ID aba:04.OUTRA Sergio")).toEqual({
      fileIdArg: "ID",
      responsavel: "Sergio",
      desde: null,
      aba: "04.OUTRA",
      escrever: false,
    });
    const r = parsearArgsProcessar("ID aba:UNA aba:DOS");
    expect(r.aba).toBe("UNA");
    expect(r.responsavel).toBe("aba:DOS");
  });

  it("desde:, aba: y --escrever combinados; el resto es el responsável", () => {
    expect(parsearArgsProcessar("ID joão baima desde:AD7 aba:03.X --escrever")).toEqual({
      fileIdArg: "ID",
      responsavel: "joão baima",
      desde: 7,
      aba: "03.X",
      escrever: true,
    });
  });
});
