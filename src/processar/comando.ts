// Handlers de /processar e /listar_docs.
//
// /listar_docs — lista todos os Google Docs sob DRIVE_FOLDER_ID com o seu path
//   e id. Útil para achar o fileId/link de um roteiro.
//
// /processar <link_o_fileId> [responsável] [desde:AD<N>]
//   1. exporta o Doc como texto;
//   2. lê headers + filas existentes de `03. ADS NOVOS`;
//   3. extrai os ads com Sonnet (tool_use forçado);
//   4. CONFIANÇA-GATING: se o modelo duvida da fase ou do tipo de algum ad
//      (confiança != alta) ou deixou notas, NÃO escreve — reporta o plano/dúvida
//      e espera;
//   5. infere a numeração do NOME por fase+tipo (ou usa `desde:<N>` se foi dado);
//      se a numeração de algum tipo é ambígua e não há `desde:`, NÃO escreve —
//      pede ao usuário re-correr com `desde:AD<N>`;
//   6. monta as filas e as adiciona com `values.append` (NUNCA update/cria estrutura).
//
// Princípio do projeto: quando não tem certeza de algo ambíguo, o bot PERGUNTA —
// não assume, não inventa. Autonomamente só adiciona filas + completa células
// pontuais; nunca cria/reestrutura abas ou pastas.

import type { Context } from "grammy";
import { listarDocsRecursivo, exportarDocTexto } from "../google/drive";
import { lerHeaders, lerFilas, appendFilas } from "../google/sheets";
import { extrairAdsDoRoteiro } from "./extrair";
import { inferNumeracao, numeracaoSequencial, faseAbrev, type Tipo } from "./numeracao";
import { buildFilasParaSheet } from "./filas";
import { extrairFileIdDeArg } from "../util/drive-url";
import { obterAccessToken } from "../google/auth";

const ABA_ADS_NOVOS = "03. ADS NOVOS";

// TODO(Etapa 4/6): ler estas fases do dropdown da col FASE (data validation,
// via spreadsheets.get includeGridData=true) em vez de hardcodear. Por ora,
// hardcoded: são as 6 do dropdown de `03. ADS NOVOS` (de references/sheet-structure.md).
const FASES_VALIDAS = [
  "captação",
  "aquecimento",
  "lembrete/comprometimento",
  "contagem regressiva",
  "avisos",
  "grupo vip",
];

interface ProcessarEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  ANTHROPIC_API_KEY: string;
  SHEET_ID: string;
  DRIVE_FOLDER_ID: string;
}

// --- /listar_docs ---

export async function tratarListarDocs(ctx: Context, env: ProcessarEnv): Promise<void> {
  try {
    const docs = await listarDocsRecursivo(env, env.DRIVE_FOLDER_ID);
    if (docs.length === 0) {
      await ctx.reply("Não encontrei Docs sob a pasta configurada (ou a SA não tem acesso).");
      return;
    }
    const linhas = docs.map((d) => `• ${d.path}\n  id: ${d.id}`).join("\n");
    // Telegram corta em ~4096 chars; manda em blocos se preciso.
    for (let i = 0; i < linhas.length; i += 3500) {
      await ctx.reply(linhas.slice(i, i + 3500));
    }
  } catch (err) {
    await ctx.reply(`Erro em /listar_docs: ${mensagemDeErro(err)}`);
  }
}

// --- /processar ---

// Parseia os args de /processar. Tokens (separados por espaço):
//   [0]                 link ou fileId  (obrigatório)
//   um token "desde:<N>" em qualquer posição depois do [0]  (opcional; N pode
//                        vir como "21" ou "AD21")
//   o resto             RESPONSÁVEL  (opcional; pode ter espaços; tudo o que
//                        não for o fileId nem o token desde:)
interface ArgsProcessar {
  fileIdArg: string | null;
  responsavel: string;
  desde: number | null;
}

export function parsearArgsProcessar(args: string): ArgsProcessar {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { fileIdArg: null, responsavel: "", desde: null };

  const fileIdArg = tokens[0]!;
  let desde: number | null = null;
  const restoResponsavel: string[] = [];

  for (const t of tokens.slice(1)) {
    const m = t.match(/^desde:(?:AD)?(\d+)$/i);
    if (m && desde === null) {
      desde = Number(m[1]);
    } else {
      restoResponsavel.push(t);
    }
  }

  return { fileIdArg, responsavel: restoResponsavel.join(" ").trim(), desde };
}

export async function tratarProcessar(ctx: Context, env: ProcessarEnv, args: string): Promise<void> {
  const { fileIdArg, responsavel, desde } = parsearArgsProcessar(args);
  const fileId = fileIdArg ? extrairFileIdDeArg(fileIdArg) : null;
  if (!fileId) {
    await ctx.reply("Uso: /processar <link do Doc ou fileId> [responsável] [desde:AD<N>]");
    return;
  }

  await ctx.reply("Recebi. Processando o roteiro… (pode levar uns segundos)");

  try {
    // 1. Texto do roteiro.
    const texto = await exportarDocTexto(env, fileId);
    if (!texto.trim()) {
      await ctx.reply("O Doc está vazio ou não pude exportá-lo como texto.");
      return;
    }

    // 2. Headers + filas existentes de `03. ADS NOVOS`.
    const headers = await lerHeaders(env, env.SHEET_ID, ABA_ADS_NOVOS);
    if (headers.length === 0) {
      await ctx.reply(`A aba "${ABA_ADS_NOVOS}" não tem cabeçalhos — não posso continuar.`);
      return;
    }
    const iNome = headers.findIndex((h) => h.trim().toLowerCase() === "nome");
    const filas = await lerFilas(env, env.SHEET_ID, ABA_ADS_NOVOS);
    const nomesExistentes = iNome >= 0 ? filas.map((f) => f[iNome] ?? "").filter(Boolean) : [];

    // 3. Extração com Sonnet.
    const ext = await extrairAdsDoRoteiro(env.ANTHROPIC_API_KEY, texto, FASES_VALIDAS);

    if (ext.ads.length === 0) {
      await ctx.reply(
        `Não escrevi nada. O modelo não identificou nenhum ad a produzir neste roteiro.` +
          (ext.notas.trim() ? `\nNotas do modelo: ${ext.notas}` : ""),
      );
      return;
    }

    // 4. Confiança-gating da extração.
    const dudasExtracao: string[] = [];
    if (ext.confianza_fase !== "alta") {
      dudasExtracao.push(`fase "${ext.fase}" (confiança ${ext.confianza_fase})`);
    }
    if (!faseAbrev(ext.fase)) {
      dudasExtracao.push(`a fase "${ext.fase}" não é uma das válidas (${FASES_VALIDAS.join(", ")})`);
    }
    ext.ads.forEach((a, i) => {
      if (a.confianza_tipo !== "alta") {
        dudasExtracao.push(`ad ${i + 1} (${a.descripcion_corta}): tipo ${a.tipo} (confiança ${a.confianza_tipo})`);
      }
    });
    if (dudasExtracao.length > 0 || ext.notas.trim()) {
      await ctx.reply(
        `Não escrevi nada. Tem coisas neste roteiro que eu não tenho certeza:\n` +
          dudasExtracao.map((d) => `• ${d}`).join("\n") +
          (ext.notas.trim() ? `\nNotas do modelo: ${ext.notas}` : "") +
          `\n\nPlano proposto: ${ext.ads.length} ad(s) de fase "${ext.fase}". Ajustá o roteiro ou me confirmá e rodá /processar de novo.`,
      );
      return;
    }

    // 5. Numeração por fase+tipo (agrupando os ads por tipo, na ordem em que aparecem).
    const tiposNaOrdem: Tipo[] = [];
    const cantPorTipo = new Map<Tipo, number>();
    for (const a of ext.ads) {
      if (!cantPorTipo.has(a.tipo)) tiposNaOrdem.push(a.tipo);
      cantPorTipo.set(a.tipo, (cantPorTipo.get(a.tipo) ?? 0) + 1);
    }

    const faseAbr = faseAbrev(ext.fase)!; // já validado acima
    const colaPorTipo = new Map<Tipo, string[]>();
    const ambiguos: string[] = [];
    // `desde:` só desambigua se o roteiro tem um único tipo (um número de arranque
    // não dá para dividir entre vários tipos). Se há vários tipos e algum é ambíguo,
    // pedimos `desde:` mesmo assim (uma execução por tipo).
    const desdeAplicavel = desde !== null && tiposNaOrdem.length === 1;

    for (const tipo of tiposNaOrdem) {
      const cant = cantPorTipo.get(tipo)!;
      if (desdeAplicavel) {
        colaPorTipo.set(tipo, numeracaoSequencial(desde!, cant, faseAbr, tipo));
        continue;
      }
      const r = inferNumeracao(nomesExistentes, ext.fase, tipo, cant);
      if (r.ambiguo) ambiguos.push(`${cant} ad(s) ${tipo} de "${ext.fase}"`);
      else colaPorTipo.set(tipo, [...r.nomes]);
    }

    if (ambiguos.length > 0) {
      await ctx.reply(
        `Não escrevi nada. Não sei que numeração usar para: ${ambiguos.join("; ")}.\n` +
          `Não há filas placeholder anteriores dessa fase+tipo na aba (ou o padrão não é claro). ` +
          `Rodá de novo dizendo de que número arrancar, ex.: \`/processar ${fileId} ${responsavel || "[responsável]"} desde:AD13\`.`,
      );
      return;
    }

    // Atribui um NOME a cada ad, na ordem, consumindo a fila do seu tipo.
    const colas = new Map<Tipo, string[]>(
      [...colaPorTipo.entries()].map(([t, ns]) => [t, [...ns]]),
    );
    const nomesAtribuidos = ext.ads.map((a) => colas.get(a.tipo)!.shift()!);

    // 6. Monta as filas e escreve (append).
    const docNome = (await nomeDoDoc(env, fileId)) ?? fileId;
    const novasFilas = buildFilasParaSheet({
      headers,
      fase: ext.fase,
      ads: ext.ads.map((a, i) => ({ nome: nomesAtribuidos[i]!, tipo: a.tipo })),
      docNome,
      responsavel,
    });
    await appendFilas(env, env.SHEET_ID, ABA_ADS_NOVOS, novasFilas);

    await ctx.reply(
      `✅ Pronto. Escrevi ${novasFilas.length} fila(s) em "${ABA_ADS_NOVOS}":\n` +
        nomesAtribuidos.map((n) => `• ${n}`).join("\n") +
        `\nFase: ${ext.fase}. Status: aberto. Responsável: ${responsavel || "(vazio)"}. Origem: ${docNome}.`,
    );
  } catch (err) {
    await ctx.reply(`Erro em /processar: ${mensagemDeErro(err)}`);
  }
}

// --- Helpers ---

function mensagemDeErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Nome do Doc (para a coluna "origem"/LINK COPY). Usa Drive files.get; se falha,
// devolve null e o caller cai para o fileId.
async function nomeDoDoc(env: ProcessarEnv, fileId: string): Promise<string | null> {
  try {
    const token = await obterAccessToken(env);
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return null;
    return ((await r.json()) as { name?: string }).name ?? null;
  } catch {
    return null;
  }
}
