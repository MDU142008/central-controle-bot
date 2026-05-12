import { describe, it, expect, vi, afterEach } from "vitest";

// Mockeamos obterAccessToken para no firmar JWTs reales: este test prueba la
// lógica de recursión por el árbol del Drive y el armado de las requests, no
// la auth (eso se ejercita contra Google de verdad en los comandos /teste_*).
vi.mock("../src/google/auth", () => ({
  obterAccessToken: vi.fn(async () => "TOKEN_FALSO"),
}));

import { listarDocsRecursivo, exportarDocTexto } from "../src/google/drive";

const env = { GOOGLE_SERVICE_ACCOUNT_JSON: "{}" } as any;

const MIME_PASTA = "application/vnd.google-apps.folder";
const MIME_DOC = "application/vnd.google-apps.document";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Helper: arma una Response JSON como las que devuelve la Drive API.
function respostaJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

// Helper: deja la query string legible (URLSearchParams codifica espacio como '+').
function queryLegivel(url: string): string {
  return decodeURIComponent(url).replace(/\+/g, " ");
}

describe("listarDocsRecursivo", () => {
  it("camina las subcarpetas y junta solo los Google Docs, con su path", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const q = queryLegivel(url);
      if (q.includes("'raiz' in parents")) {
        return respostaJson({
          files: [
            { id: "sub1", name: "1. Criativos", mimeType: MIME_PASTA },
            { id: "docA", name: "Doc na raiz", mimeType: MIME_DOC },
            { id: "vid1", name: "video.mp4", mimeType: "video/mp4" },
          ],
        });
      }
      if (q.includes("'sub1' in parents")) {
        return respostaJson({
          files: [
            { id: "docB", name: "1. Criativos de Captação", mimeType: MIME_DOC },
            { id: "sub2", name: "Vazia", mimeType: MIME_PASTA },
          ],
        });
      }
      // sub2: vacía
      return respostaJson({ files: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const docs = await listarDocsRecursivo(env, "raiz");

    // Orden = recorrido en profundidad: como las carpetas vienen antes que los
    // archivos (orderBy folder,name), primero baja a "1. Criativos" y devuelve
    // su Doc, y recién después el Doc suelto de la raíz.
    expect(docs).toEqual([
      { id: "docB", name: "1. Criativos de Captação", path: "1. Criativos/1. Criativos de Captação" },
      { id: "docA", name: "Doc na raiz", path: "Doc na raiz" },
    ]);
    // pasa el token (mockeado) en el header Authorization
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: "Bearer TOKEN_FALSO" },
    });
  });

  it("respeta maxDepth (no baja infinito ante un ciclo)", async () => {
    // una carpeta que se contiene a sí misma: sin maxDepth sería loop infinito
    const fetchMock = vi.fn(async () =>
      respostaJson({ files: [{ id: "loop", name: "Loop", mimeType: MIME_PASTA }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listarDocsRecursivo(env, "loop", 3)).resolves.toEqual([]);
    // walk en profundidades 0,1,2,3 piden hijos; en 4 corta antes de pedir -> 4 fetches
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("sigue la paginación (nextPageToken)", async () => {
    let llamada = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (queryLegivel(url).includes("'raiz' in parents")) {
        llamada++;
        if (llamada === 1) {
          return respostaJson({
            nextPageToken: "PG2",
            files: [{ id: "d1", name: "Doc 1", mimeType: MIME_DOC }],
          });
        }
        return respostaJson({ files: [{ id: "d2", name: "Doc 2", mimeType: MIME_DOC }] });
      }
      return respostaJson({ files: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const docs = await listarDocsRecursivo(env, "raiz");
    expect(docs.map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  it("lanza si la Drive API responde con error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    await expect(listarDocsRecursivo(env, "raiz")).rejects.toThrow(/403/);
  });
});

describe("exportarDocTexto", () => {
  it("pide files/<id>/export como text/plain y devuelve el texto", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/files/doc123/export");
      expect(url).toContain("mimeType=text/plain");
      return new Response("Objetivo: Captação\n\nAD 1 ...");
    });
    vi.stubGlobal("fetch", fetchMock);

    const texto = await exportarDocTexto(env, "doc123");
    expect(texto).toContain("Objetivo: Captação");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: "Bearer TOKEN_FALSO" },
    });
  });

  it("lanza si el export falla", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(exportarDocTexto(env, "doc123")).rejects.toThrow(/404/);
  });
});
