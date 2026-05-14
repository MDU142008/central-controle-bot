// Helpers para a Google Sheets API v4. Chamadas REST diretas com fetch;
// autenticação delegada ao módulo auth (Service Account + JWT).

import { obterAccessToken, type AuthEnv } from "./auth";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

// Monta um range em notação A1 referenciando uma aba. Nomes de aba com
// espaços, pontos ou começando com dígito (ex.: "03. ADS NOVOS") PRECISAM
// de aspas simples na notação A1; aspas simples internas se escapam duplicando.
// Sempre colocar aspas é seguro (funciona até para nomes simples).
function rangeComAba(aba: string, celulas: string): string {
  return `'${aba.replace(/'/g, "''")}'!${celulas}`;
}

async function buscarValores(token: string, sheetId: string, range: string): Promise<string[][]> {
  const url = `${BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
  const resposta = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`Falha ao ler Sheet (range ${range}, status ${resposta.status}): ${corpo}`);
  }
  const dados = (await resposta.json()) as { values?: string[][] };
  return dados.values ?? [];
}

// Lê a primeira linha (cabeçalhos) de uma aba. Devolve [] se estiver vazia.
// A API trima células vazias no fim da linha mas mantém as do meio (ex.:
// ["FASE","NOME","COPY","","DESIGN OU EDIÇÃO","","STATUS",...]).
export async function lerHeaders(env: AuthEnv, sheetId: string, aba: string): Promise<string[]> {
  const token = await obterAccessToken(env);
  const linhas = await buscarValores(token, sheetId, rangeComAba(aba, "1:1"));
  return linhas[0] ?? [];
}

// Lê todas as linhas de dados (a partir da linha 2) de uma aba. Devolve uma
// matriz linha×coluna; cada linha pode ter comprimento diferente (a API trima
// vazios no fim). Devolve [] se não houver dados.
export async function lerFilas(env: AuthEnv, sheetId: string, aba: string): Promise<string[][]> {
  const token = await obterAccessToken(env);
  return buscarValores(token, sheetId, rangeComAba(aba, "A2:ZZ"));
}

export interface ResultadoEscrita {
  // Range A1 que a API efetivamente escreveu, ex.: "'03. ADS NOVOS'!A6:K16".
  updatedRange?: string;
  updatedRows?: number;
}

// Acha a primeira fila onde podemos escrever `cantidad` filas consecutivas sem
// sobrescrever dados. "Vazia" = colunas A e B (FASE+NOME) sem texto — as duas
// chaves visíveis de uma linha real. Útil porque as Sheets do equipo tem
// MUITAS filas pré-formatadas vazias (com dropdowns/data validation mas sem
// valores); o `values.append` da API conta isso como "parte da tabela" e
// empurra o write pra centenas de filas abaixo. Aqui apontamos exatamente
// onde escrever, deixando o output visualmente junto aos dados existentes.
//
// `filas` é o que `lerFilas` devolve (a partir da fila 2 do spreadsheet).
// `iColA` e `iColB` são índices das colunas a usar como discriminador
// (tipicamente iFase e iNome). Retorna 1-indexed (fila 2 = primeira sob o
// header em A1). Se não há bloco grande o suficiente nas filas existentes,
// devolve a fila seguinte ao último dado (equivalente a um append "manual").
export function acharFilaInicio(
  filas: string[][],
  iColA: number,
  iColB: number,
  cantidad: number,
): number {
  const filaVazia = (i: number): boolean => {
    const row = filas[i] ?? [];
    const a = (row[iColA] ?? "").trim();
    const b = (row[iColB] ?? "").trim();
    return !a && !b;
  };
  if (cantidad > 0) {
    for (let i = 0; i + cantidad <= filas.length; i++) {
      let todasVazias = true;
      for (let j = 0; j < cantidad; j++) {
        if (!filaVazia(i + j)) {
          todasVazias = false;
          break;
        }
      }
      if (todasVazias) return i + 2;
    }
  }
  // Fallback: depois do último dado (ignorando ghost-rows vazias finais).
  let ultimoComDados = 1; // sem dados ainda; vamos retornar 2 se ficar assim
  for (let i = 0; i < filas.length; i++) {
    if (!filaVazia(i)) ultimoComDados = i + 2;
  }
  return ultimoComDados + 1;
}

// Escreve filas num range específico via `values.update`. Diferente de um
// `values.append`: NÃO depende da heurística de "tabela" da Sheets API (que
// trata filas pré-formatadas com dropdowns como parte da tabela). Combinada
// com `acharFilaInicio`, escreve exatamente embaixo dos dados existentes,
// preservando data validation, dropdowns e formato das células sobrescritas.
//
// `filaInicio` é 1-indexed (fila 2 = primeira de dados). USER_ENTERED faz a
// API interpretar valores como se o usuário tivesse digitado ("FALSE" vira
// boolean para checkboxes, "captação" segue texto, etc.).
export async function escreverFilas(
  env: AuthEnv,
  sheetId: string,
  aba: string,
  filaInicio: number,
  valores: string[][],
): Promise<ResultadoEscrita> {
  if (valores.length === 0) return { updatedRows: 0 };
  const token = await obterAccessToken(env);
  const numCols = valores[0]!.length;
  const colFim = letraDeColuna(numCols);
  const filaFim = filaInicio + valores.length - 1;
  const range = rangeComAba(aba, `A${filaInicio}:${colFim}${filaFim}`);
  const url =
    `${BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}` +
    `?valueInputOption=USER_ENTERED`;

  const resposta = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: valores }),
  });

  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`Falha ao escrever na Sheet (aba ${aba}, status ${resposta.status}): ${corpo}`);
  }

  const dados = (await resposta.json()) as {
    updatedRange?: string;
    updatedRows?: number;
  };
  return { updatedRange: dados.updatedRange, updatedRows: dados.updatedRows };
}

// Converte índice 1-based de coluna para letra A1: 1 -> A, 26 -> Z, 27 -> AA.
function letraDeColuna(n: number): string {
  let resultado = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    resultado = String.fromCharCode(65 + r) + resultado;
    n = Math.floor((n - 1) / 26);
  }
  return resultado;
}

// Lista os títulos das abas da spreadsheet. Usa `?fields=sheets.properties.title`
// pra trazer só os nomes (sem grid/formatos) — dezenas a centenas de KB mais
// leve que o GET sem filtro. Ordem da resposta = ordem das abas na Sheet.
export async function listarTitulosAbas(env: AuthEnv, sheetId: string): Promise<string[]> {
  const token = await obterAccessToken(env);
  const url = `${BASE}/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`;
  const resposta = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`Falha ao listar abas (status ${resposta.status}): ${corpo}`);
  }
  const dados = (await resposta.json()) as {
    sheets?: { properties?: { title?: string } }[];
  };
  return (dados.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
}

// --- Compat: o smoke test da Etapa 2 (/teste_sheet) ainda usa isto ---

// Lê a primeira linha (range A1:Z1) da primeira aba da spreadsheet.
export async function lerPrimeiraLinha(env: AuthEnv, sheetId: string): Promise<string[]> {
  const token = await obterAccessToken(env);
  const linhas = await buscarValores(token, sheetId, "A1:Z1");
  return linhas[0] ?? [];
}
