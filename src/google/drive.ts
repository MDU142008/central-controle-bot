// Helpers para a Google Drive API v3. Chamadas REST diretas com fetch;
// autenticação delegada ao módulo auth (Service Account + JWT).

import { obterAccessToken, type AuthEnv } from "./auth";

export interface ArquivoDrive {
  id: string;
  name: string;
}

// Lista arquivos diretamente dentro de uma pasta do Drive. Devolve apenas id
// e name; arquivos em sub-pastas NÃO são incluídos (não é recursivo).
//
// O parâmetro "q" é a Drive Query Language. "'<folderId>' in parents" filtra
// pelos itens cujo pai é a pasta dada.
// O parâmetro "fields" limita a resposta para reduzir payload.
export async function listarArquivosNaPasta(
  env: AuthEnv,
  folderId: string,
): Promise<ArquivoDrive[]> {
  const token = await obterAccessToken(env);

  const query = `'${folderId}' in parents`;
  const url =
    `https://www.googleapis.com/drive/v3/files` +
    `?q=${encodeURIComponent(query)}` +
    `&fields=${encodeURIComponent("files(id,name)")}`;

  const resposta = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(
      `Falha ao listar arquivos do Drive (status ${resposta.status}): ${corpo}`,
    );
  }

  const dados = (await resposta.json()) as { files?: ArquivoDrive[] };
  return dados.files ?? [];
}
