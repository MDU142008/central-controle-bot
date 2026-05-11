import { describe, it, expect } from "vitest";
import { extrairFileIdDeArg } from "../src/util/drive-url";

describe("extrairFileIdDeArg", () => {
  it("fileId crudo", () => {
    expect(extrairFileIdDeArg("1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18")).toBe(
      "1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18",
    );
  });

  it("URL de Google Docs", () => {
    expect(
      extrairFileIdDeArg(
        "https://docs.google.com/document/d/1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18/edit",
      ),
    ).toBe("1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18");
  });

  it("URL de Google Sheets", () => {
    expect(
      extrairFileIdDeArg(
        "https://docs.google.com/spreadsheets/d/1jpnIevIBmws-yZa2VndXFuCwAy5bszKJo146GtVynjs/edit#gid=0",
      ),
    ).toBe("1jpnIevIBmws-yZa2VndXFuCwAy5bszKJo146GtVynjs");
  });

  it("URL de Drive con ?id=", () => {
    expect(
      extrairFileIdDeArg("https://drive.google.com/open?id=1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18"),
    ).toBe("1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18");
  });

  it("URL de carpeta de Drive", () => {
    expect(
      extrairFileIdDeArg("https://drive.google.com/drive/folders/1SwXBezQQnhBnxtJCnO84oS8xxdd4MWX8"),
    ).toBe("1SwXBezQQnhBnxtJCnO84oS8xxdd4MWX8");
  });

  it("arg con espacios alrededor", () => {
    expect(extrairFileIdDeArg("  1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18  ")).toBe(
      "1zZE5Jla_n-OByerjKmnSVRQxF3eLbMKXGmb4gv_tp18",
    );
  });

  it("arg inválido devuelve null", () => {
    expect(extrairFileIdDeArg("hola mundo")).toBeNull();
    expect(extrairFileIdDeArg("")).toBeNull();
    expect(extrairFileIdDeArg("   ")).toBeNull();
  });
});
