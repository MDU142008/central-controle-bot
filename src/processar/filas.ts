// Mapeia a extração do roteiro -> filas para a aba `03. ADS NOVOS`.
//
// Headers reais de `03. ADS NOVOS` (de references/sheet-structure.md):
//   ["FASE","NOME","COPY","","DESIGN OU EDIÇÃO","","STATUS","RESPONSÁVEL",
//    "LINK ADS FINALIZADO","REVISÃO FINAL","GESTOR DE ADS RECEBEU"]
// A col D não tem header na linha 1 (vem vazia), mas a linha 2 a rotula "LINK COPY";
// nas filas reais ela contém o nome do Doc roteiro de origem (ex.: "1. Criativos
// de Captação - primeira Leva"). A col F também vem vazia (sem uso conhecido).
//
// Mapeamento de uma fila nova (placeholder, status aberto):
//   FASE              = a fase do briefing (minúsculas, como o dropdown)
//   NOME              = o placeholder AD<N>-<FASE>-<SUFIJO_TIPO>
//   COPY              = "aberto"
//   (col D, LINK COPY)= o nome do Doc roteiro de origem (informação útil; o time
//                        a preenche assim — ver HUECOS.md §14.4)
//   DESIGN OU EDIÇÃO  = "Edição de vídeo" se VID; "Design" se EST/CAR
//   (col F)           = vazia
//   STATUS            = "aberto"
//   RESPONSÁVEL       = o parâmetro de /processar, ou "" (NUNCA se infere)
//   LINK ADS FINALIZADO = ""  (o arquivo ainda não existe)
//   REVISÃO FINAL     = "FALSE"  (checkbox; USER_ENTERED converte para booleano)
//   GESTOR DE ADS RECEBEU = "FALSE"
//
// As filas são montadas por NOME de coluna (case-insensitive, trim), não por
// posição fixa — assim toleramos pequenas variações de layout entre Sheets.

import type { Tipo } from "./numeracao";

export function tipoToDesignOuEdicao(tipo: Tipo): string {
  return tipo === "VID" ? "Edição de vídeo" : "Design";
}

export interface AdNovo {
  nome: string;
  tipo: Tipo;
}

export interface BuildFilasInput {
  headers: string[];
  fase: string; // como o dropdown, minúsculas (ex.: "captação")
  ads: AdNovo[];
  docNome: string; // nome do Doc roteiro de origem (vai na col "LINK COPY")
  responsavel: string; // "" se não foi dado
}

// Devolve filas (matriz linha×coluna) alinhadas a `headers` por NOME de coluna.
// Colunas que não reconhecemos ficam "".
export function buildFilasParaSheet(input: BuildFilasInput): string[][] {
  const idx = (nome: string) =>
    input.headers.findIndex((h) => h.trim().toLowerCase() === nome.toLowerCase());

  const iFase = idx("FASE");
  const iNome = idx("NOME");
  const iCopy = idx("COPY");
  const iDesign = idx("DESIGN OU EDIÇÃO");
  const iStatus = idx("STATUS");
  const iResp = idx("RESPONSÁVEL");
  const iLink = idx("LINK ADS FINALIZADO");
  const iRev = idx("REVISÃO FINAL");
  const iGestor = idx("GESTOR DE ADS RECEBEU");
  // A col "LINK COPY" não tem header na linha 1 (header vazio) — nas filas reais
  // é a coluna logo depois de COPY. Só a usamos se COPY foi localizada.
  const iLinkCopy = iCopy >= 0 ? iCopy + 1 : -1;

  return input.ads.map((ad) => {
    const fila = new Array<string>(input.headers.length).fill("");
    const set = (i: number, v: string) => {
      if (i >= 0 && i < fila.length) fila[i] = v;
    };
    set(iFase, input.fase);
    set(iNome, ad.nome);
    set(iCopy, "aberto");
    set(iLinkCopy, input.docNome);
    set(iDesign, tipoToDesignOuEdicao(ad.tipo));
    set(iStatus, "aberto");
    set(iResp, input.responsavel);
    set(iLink, "");
    set(iRev, "FALSE");
    set(iGestor, "FALSE");
    return fila;
  });
}
