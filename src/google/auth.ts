// Autenticação com Google APIs via Service Account.
//
// Por que JWT na mão e não a googleapis SDK: o SDK oficial pesa demais para
// Workers (>1MB compactado) e usa APIs Node que não existem no runtime. Aqui
// montamos o JWT manualmente com Web Crypto API e batemos no endpoint OAuth2
// com fetch — assim mantemos o bundle pequeno e dependências mínimas.
//
// Fluxo OAuth2 do Google para Service Accounts (RFC 7523, "JWT Bearer"):
//   1. Montamos um JWT assinado com a private_key da SA (algoritmo RS256).
//   2. Trocamos esse JWT no endpoint /token por um access_token de curta duração.
//   3. Usamos o access_token no header Authorization das chamadas a Sheets/Drive.

// Subconjunto do tipo Env: este módulo só precisa do JSON da SA. Os módulos
// que dependem de auth (sheets, drive) reutilizam essa interface.
export interface AuthEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
}

// Subconjunto dos campos do JSON de uma Service Account que usamos. O JSON
// completo tem mais campos (project_id, token_uri, etc.) que não precisamos.
interface ServiceAccountJSON {
  client_email: string;
  private_key: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// Scopes solicitados no JWT. Espaço-separados conforme a spec OAuth2.
//   - spreadsheets: leitura/escrita de Google Sheets
//   - drive.readonly: listagem/leitura (sem escrita) de Google Drive
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

// Cache em escopo de módulo. Caveat: cada isolate do Worker tem seu próprio
// escopo, então isso NÃO é cache global — cada isolate vai pegar seu próprio
// token na primeira chamada. Aceitável nesta etapa: o token vive 60 min e
// devolvê-lo do cache evita o JWT roundtrip nas chamadas subsequentes do
// mesmo isolate (que costumam vir em rajada quando há atividade).
let tokenCache: { token: string; expiraEm: number } | null = null;

export async function obterAccessToken(env: AuthEnv): Promise<string> {
  // Margem de 60s para evitar usar um token que expira durante a request.
  if (tokenCache && Date.now() < tokenCache.expiraEm - 60_000) {
    return tokenCache.token;
  }

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccountJSON;

  // Monta header e claim do JWT. iat/exp em segundos UNIX; exp = iat + 1h é o
  // máximo aceito pelo Google para JWTs de Service Account.
  const agora = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPES,
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  };

  // base64url do header e claim, concatenados com ponto. Esse é o "data" que
  // será assinado.
  const headerB64 = base64urlString(JSON.stringify(header));
  const claimB64 = base64urlString(JSON.stringify(claim));
  const dadosParaAssinar = `${headerB64}.${claimB64}`;

  // Importa a private_key (formato PEM dentro do JSON) e assina.
  const chave = await importarChavePrivada(sa.private_key);
  const assinatura = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    chave,
    new TextEncoder().encode(dadosParaAssinar),
  );
  const assinaturaB64 = base64urlBytes(new Uint8Array(assinatura));

  const jwt = `${dadosParaAssinar}.${assinaturaB64}`;

  // Troca o JWT por um access_token. Note o grant_type específico para
  // JWT Bearer (não confundir com o grant_type "client_credentials" comum).
  const resposta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });

  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(
      `Falha ao obter access_token (status ${resposta.status}): ${corpo}`,
    );
  }

  const dados = (await resposta.json()) as TokenResponse;

  tokenCache = {
    token: dados.access_token,
    expiraEm: Date.now() + dados.expires_in * 1000,
  };

  return dados.access_token;
}

// --- Helpers internos ---

// base64url (RFC 4648 §5): base64 padrão sem padding, com '+' -> '-' e '/' -> '_'.
// Obrigatório para JWT — base64 padrão quebraria a segmentação por '.'.
function base64urlString(input: string): string {
  return base64urlBytes(new TextEncoder().encode(input));
}

function base64urlBytes(bytes: Uint8Array): string {
  // btoa só aceita string com bytes em char codes 0-255, então convertemos
  // o Uint8Array para uma string binária um caractere de cada vez.
  let binario = "";
  for (const byte of bytes) {
    binario += String.fromCharCode(byte);
  }
  return btoa(binario)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Converte a private_key PEM (texto) em CryptoKey utilizável por subtle.sign.
// A chave vem entre "-----BEGIN PRIVATE KEY-----" e "-----END PRIVATE KEY-----"
// com newlines reais (após JSON.parse). Removemos cabeçalho/rodapé e todos os
// whitespaces para ficar com o corpo base64 puro, decodificamos para bytes
// e importamos como PKCS#8 (formato padrão para chaves privadas em PEM).
async function importarChavePrivada(pem: string): Promise<CryptoKey> {
  const corpoBase64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    // Cobre o caso em que o JSON foi serializado com '\n' duplo-escapado:
    .replace(/\\n/g, "")
    // Newlines reais, espaços, tabs:
    .replace(/\s+/g, "");

  const binario = atob(corpoBase64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) {
    bytes[i] = binario.charCodeAt(i);
  }

  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
