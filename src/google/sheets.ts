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

export interface ResultadoAppend {
  // Range A1 que a API efetivamente escreveu, ex.: "'03. ADS NOVOS'!A1007:K1009".
  updatedRange?: string;
  updatedRows?: number;
}

// Adiciona linhas ao final de uma aba (values.append — NUNCA update, não
// sobrescreve nada). `valores` = matriz linha×coluna. valueInputOption=
// USER_ENTERED faz a API interpretar os valores como se o usuário os tivesse
// digitado (ex.: "FALSE" vira o booleano FALSE que as colunas checkbox esperam,
// "captação" continua texto). insertDataOption=INSERT_ROWS empurra linhas novas
// em vez de sobrescrever as de baixo.
export async function appendFilas(
  env: AuthEnv,
  sheetId: string,
  aba: string,
  valores: string[][],
): Promise<ResultadoAppend> {
  const token = await obterAccessToken(env);
  const range = rangeComAba(aba, "A1");
  const url =
    `${BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const resposta = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: valores }),
  });

  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`Falha ao escrever na Sheet (aba ${aba}, status ${resposta.status}): ${corpo}`);
  }

  const dados = (await resposta.json()) as {
    updates?: { updatedRange?: string; updatedRows?: number };
  };
  return {
    updatedRange: dados.updates?.updatedRange,
    updatedRows: dados.updates?.updatedRows,
  };
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
