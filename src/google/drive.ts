// Helpers para a Google Drive API v3. Chamadas REST diretas com fetch;
// autenticação delegada ao módulo auth (Service Account + JWT).
//
// Por que recursão manual e não "in ancestors": a Drive API v3 NÃO suporta
// o operador "in ancestors" na query — só "'<id>' in parents" (filhos diretos).
// Para "todos os Docs sob uma pasta" caminhamos o árvore pasta por pasta.

import { obterAccessToken, type AuthEnv } from "./auth";

const MIME_PASTA = "application/vnd.google-apps.folder";
const MIME_DOC = "application/vnd.google-apps.document";

// Um Google Doc encontrado no Drive, com o caminho relativo à pasta raiz
// passada a listarDocsRecursivo (ex.: "1. Criativos/1. Criativos de Captação").
// O path serve para o usuário identificar o roteiro entre vários.
export interface DocDrive {
  id: string;
  name: string;
  path: string;
}

interface ArquivoDrive {
  id: string;
  name: string;
  mimeType: string;
}

// Lista os filhos diretos de uma pasta, seguindo a paginação até o fim.
// "'<id>' in parents and trashed=false" pega os itens (não lixeira) cujo pai
// é a pasta dada. "fields" limita o payload; orderBy deixa a ordem estável.
async function listarFilhosDaPasta(token: string, folderId: string): Promise<ArquivoDrive[]> {
  const itens: ArquivoDrive[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "1000",
      orderBy: "folder,name",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const resposta = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resposta.ok) {
      const corpo = await resposta.text();
      throw new Error(
        `Falha ao listar filhos da pasta ${folderId} (status ${resposta.status}): ${corpo}`,
      );
    }

    const dados = (await resposta.json()) as {
      files?: ArquivoDrive[];
      nextPageToken?: string;
    };
    itens.push(...(dados.files ?? []));
    pageToken = dados.nextPageToken;
  } while (pageToken);

  return itens;
}

// Caminha o árvore a partir de folderId e devolve TODOS os Google Docs
// (recursivo, em ordem de descida). maxDepth evita descer infinito caso
// existam ciclos de atalhos.
export async function listarDocsRecursivo(
  env: AuthEnv,
  folderId: string,
  maxDepth = 10,
): Promise<DocDrive[]> {
  const token = await obterAccessToken(env);
  const docs: DocDrive[] = [];

  async function caminhar(id: string, prefixo: string, profundidade: number): Promise<void> {
    if (profundidade > maxDepth) return;
    const filhos = await listarFilhosDaPasta(token, id);
    for (const filho of filhos) {
      const caminhoFilho = prefixo ? `${prefixo}/${filho.name}` : filho.name;
      if (filho.mimeType === MIME_PASTA) {
        await caminhar(filho.id, caminhoFilho, profundidade + 1);
      } else if (filho.mimeType === MIME_DOC) {
        docs.push({ id: filho.id, name: filho.name, path: caminhoFilho });
      }
      // outros mimeTypes (vídeos, imagens, PDFs, ...) são ignorados aqui.
    }
  }

  await caminhar(folderId, "", 0);
  return docs;
}

// Exporta um Google Doc como texto plano (files.export). Usado para passar o
// conteúdo de um roteiro ao modelo. Para arquivos que não sejam Google Docs
// nativos isto falha — o caller deve garantir que fileId é um Doc.
export async function exportarDocTexto(env: AuthEnv, fileId: string): Promise<string> {
  const token = await obterAccessToken(env);

  const resposta = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(
      `Falha ao exportar o Doc ${fileId} (status ${resposta.status}): ${corpo}`,
    );
  }

  return resposta.text();
}
