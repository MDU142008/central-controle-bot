// Helpers para a Google Sheets API v4. Chamadas REST diretas com fetch;
// autenticação delegada ao módulo auth (Service Account + JWT).

import { obterAccessToken, type AuthEnv } from "./auth";

// Lê a primeira linha (range A1:Z1) de uma spreadsheet. Devolve as células
// como array de strings; se a linha estiver vazia, devolve [].
//
// A API Sheets retorna o shape:
//   { range: "...", majorDimension: "ROWS", values: [["a", "b", ...]] }
// Quando não há dados na linha, "values" pode vir undefined.
export async function lerPrimeiraLinha(
  env: AuthEnv,
  sheetId: string,
): Promise<string[]> {
  const token = await obterAccessToken(env);

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/A1:Z1`;

  const resposta = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(
      `Falha ao ler Sheet (status ${resposta.status}): ${corpo}`,
    );
  }

  const dados = (await resposta.json()) as { values?: string[][] };
  return dados.values?.[0] ?? [];
}
