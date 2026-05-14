// Handlers de /processar e /listar_docs.
//
// /listar_docs — lista todos os Google Docs sob DRIVE_FOLDER_ID com o seu path
//   e id. Útil para achar o fileId/link de um roteiro.
//
// /processar <link_o_fileId> [responsável] [desde:AD<N>] [aba:<nome>] [--escrever]
//   1. exporta o Doc como texto;
//   2. lê headers + filas existentes da aba destino (por padrão `03. ADS NOVOS`);
//   3. deriva as FASES VÁLIDAS dos DADOS REAIS (col FASE das filas existentes) —
//      não de uma lista hardcodeada; se a col FASE está vazia, passa [] e o
//      prompt de `extrair.ts` instrui o modelo a usar a fase do briefing tal qual
//      marcando `confianza_fase: "media"`;
//   4. extrai os ads com Sonnet (tool_use forçado);
//   5. CONFIANÇA-GATING: se o modelo duvida da fase ou do tipo de algum ad
//      (confiança != alta) ou deixou notas, NÃO escreve — mesmo com --escrever;
//   6. infere a numeração do NOME por fase+tipo (ou usa `desde:<N>` se foi dado);
//      se a numeração de algum tipo é ambígua e não há `desde:`, igual calcula um
//      PALPITE (max(N)+1 das filas placeholder dessa fase+tipo, ou 1 se não há
//      nenhuma) e o mostra como palpite, pedindo confirmação — não escreve;
//   7. DRY-RUN POR PADRÃO: monta o plano completo (fase, confianças, os NOMEs
//      exatos que geraria, RESPONSÁVEL, aba destino, nº de filas) e o reporta,
//      terminando com a linha exata para re-correr COM `--escrever`. Só quando
//      `--escrever` está presente (e nada bloqueia) ele escreve de verdade, com
//      `values.append` (NUNCA update/cria estrutura).
//
// Princípio do projeto: quando não tem certeza de algo ambíguo, o bot PERGUNTA —
// não assume, não inventa. E mesmo "confiado", a nomenclatura é genuinamente
// incerta (escrevemos numa Sheet real): por isso /processar é dry-run por padrão
// e sempre convida o humano a corrigir a nomenclatura. Autonomamente só adiciona
// filas + completa células pontuais; nunca cria/reestrutura abas ou pastas.

import type { Context } from "grammy";
import { listarDocsRecursivo, exportarDocTexto } from "../google/drive";
import { lerHeaders, lerFilas, escreverFilas, acharFilaInicio, listarTitulosAbas } from "../google/sheets";
import { extrairAdsDoRoteiro } from "./extrair";
import {
  numeracaoSequencial,
  faseAbrev,
  derivarFaseAbrevDosNomes,
  fasesPresentesNosDados,
  parseNome,
  type Tipo,
} from "./numeracao";
import { buildFilasParaSheet } from "./filas";
import { resolverAbaAdsNovos } from "./aba";
import { extrairFileIdDeArg } from "../util/drive-url";
import { obterAccessToken } from "../google/auth";

// Aba destino: o bot DESCOBRE qual aba "ads novos" existe na Sheet (via
// `resolverAbaAdsNovos` sobre os títulos reais) — não é hardcoded, pode variar
// entre experts/launches. A descoberta robusta com confirmação humana é
// trabalho da Etapa 4 (`/mapear`); por ora fazemos matching leve por nome
// normalizado. O parser aceita `aba:<nome>` pra forçar uma aba específica
// (validamos que existe na Sheet).

interface ProcessarEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  ANTHROPIC_API_KEY: string;
  SHEET_ID: string;
  DRIVE_FOLDER_ID: string;
  // Endpoint do Cloudflare AI Gateway para a Anthropic (opcional). "" ou
  // undefined = não configurado (cliente Anthropic direto). Ver wrangler.toml.
  AI_GATEWAY_BASE_URL?: string;
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
//   "desde:<N>"         (opcional; em qualquer posição depois do [0]; só o
//                        primeiro conta; N pode vir como "21" ou "AD21")
//   "aba:<nome>"        (opcional; sobreescreve a aba destino; só o primeiro
//                        conta; o nome NÃO pode ter espaços nesta forma simples)
//   "--escrever"        (opcional; em qualquer posição; desliga o dry-run)
//   o resto             RESPONSÁVEL  (opcional; pode ter espaços; tudo o que não
//                        for o fileId, desde:, aba: nem --escrever)
interface ArgsProcessar {
  fileIdArg: string | null;
  responsavel: string;
  desde: number | null;
  aba: string | null;
  escrever: boolean;
}

export function parsearArgsProcessar(args: string): ArgsProcessar {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0)
    return { fileIdArg: null, responsavel: "", desde: null, aba: null, escrever: false };

  const fileIdArg = tokens[0]!;
  let desde: number | null = null;
  let aba: string | null = null;
  let escrever = false;
  const restoResponsavel: string[] = [];

  for (const t of tokens.slice(1)) {
    if (t === "--escrever") {
      escrever = true;
      continue;
    }
    const mDesde = t.match(/^desde:(?:AD)?(\d+)$/i);
    if (mDesde && desde === null) {
      desde = Number(mDesde[1]);
      continue;
    }
    const mAba = t.match(/^aba:(.+)$/i);
    if (mAba && aba === null) {
      aba = mAba[1]!;
      continue;
    }
    restoResponsavel.push(t);
  }

  return { fileIdArg, responsavel: restoResponsavel.join(" ").trim(), desde, aba, escrever };
}

// Reconstrói a linha de comando "canônica" para re-correr (mostrada no dry-run e
// nas mensagens de palpite). `extra` são tokens adicionais a juntar (ex.: o
// `desde:AD<N>` do palpite, e/ou `--escrever`).
function linhaParaRecorrer(
  fileId: string,
  responsavel: string,
  abaArg: string | null,
  extra: string[],
): string {
  const partes = [`/processar`, fileId];
  if (responsavel) partes.push(responsavel);
  if (abaArg) partes.push(`aba:${abaArg}`);
  partes.push(...extra);
  return partes.join(" ");
}

export async function tratarProcessar(ctx: Context, env: ProcessarEnv, args: string): Promise<void> {
  const { fileIdArg, responsavel, desde, aba: abaArg, escrever } = parsearArgsProcessar(args);
  const fileId = fileIdArg ? extrairFileIdDeArg(fileIdArg) : null;
  if (!fileId) {
    await ctx.reply(
      "Uso: /processar <link do Doc ou fileId> [responsável] [desde:AD<N>] [aba:<nome>] [--escrever]\n" +
        "Sem --escrever é dry-run: te mostro o que faria e a linha pra confirmar.",
    );
    return;
  }
  await ctx.reply("Recebi. Processando o roteiro… (pode levar uns segundos)");

  try {
    console.log(`[/processar] início, fileId=${fileId}`);

    // Pré-processo: descobrir qual é a aba destino na Sheet (não assumimos um
    // nome fixo — pode ser "03. ADS NOVOS", "3 ads novos", "Ads Novos", etc.).
    // Se o usuário passou `aba:<nome>`, validamos que essa aba existe na Sheet.
    console.log(`[/processar] passo 0: listarTitulosAbas…`);
    const titulosAbas = await listarTitulosAbas(env, env.SHEET_ID);
    console.log(`[/processar] passo 0 ok: ${titulosAbas.length} abas`);
    let aba: string;
    if (abaArg) {
      if (!titulosAbas.includes(abaArg)) {
        await ctx.reply(
          `Não encontrei a aba "${abaArg}" na Sheet. As abas existentes são:\n` +
            titulosAbas.map((t) => `• ${t}`).join("\n"),
        );
        return;
      }
      aba = abaArg;
    } else {
      const r = resolverAbaAdsNovos(titulosAbas);
      if (r.tipo === "nenhuma") {
        await ctx.reply(
          `Não achei uma aba parecida com "ads novos" na Sheet ` +
            `(procuro variações tipo "03. ADS NOVOS", "3 ads novos", "Ads Novos", etc.).\n` +
            `As abas existentes são:\n` +
            titulosAbas.map((t) => `• ${t}`).join("\n") +
            `\n\nSe a aba certa está na lista com outro nome, re-corra com ` +
            "`aba:<nome exato sem espaços>` ou peça pra renomear a aba.",
        );
        return;
      }
      if (r.tipo === "varias") {
        await ctx.reply(
          `Achei várias abas que parecem "ads novos":\n` +
            r.candidatos.map((t) => `• ${t}`).join("\n") +
            "\n\nRe-corra com `aba:<nome exato>` pra escolher uma.",
        );
        return;
      }
      aba = r.titulo;
    }

    // 1. Texto do roteiro.
    console.log(`[/processar] passo 1: exportarDocTexto…`);
    const texto = await exportarDocTexto(env, fileId);
    console.log(`[/processar] passo 1 ok: ${texto.length} chars`);
    if (!texto.trim()) {
      await ctx.reply("O Doc está vazio ou não pude exportá-lo como texto.");
      return;
    }

    // 2. Headers + filas existentes da aba destino.
    console.log(`[/processar] passo 2a: lerHeaders aba="${aba}"…`);
    const headers = await lerHeaders(env, env.SHEET_ID, aba);
    console.log(`[/processar] passo 2a ok: ${headers.length} headers`);
    if (headers.length === 0) {
      await ctx.reply(`A aba "${aba}" não tem cabeçalhos — não posso continuar.`);
      return;
    }
    const iNome = headers.findIndex((h) => h.trim().toLowerCase() === "nome");
    const iFase = headers.findIndex((h) => h.trim().toLowerCase() === "fase");
    console.log(`[/processar] passo 2b: lerFilas…`);
    const filas = await lerFilas(env, env.SHEET_ID, aba);
    console.log(`[/processar] passo 2b ok: ${filas.length} filas`);
    const nomesExistentes = iNome >= 0 ? filas.map((f) => f[iNome] ?? "").filter(Boolean) : [];

    // 3. Fases válidas DERIVADAS DOS DADOS (col FASE das filas existentes), não
    // hardcodeadas. Se a col FASE está vazia (aba nova sem dados) -> [], e o
    // prompt de extrair.ts manda o modelo usar a fase do briefing tal qual com
    // confianza_fase: "media" (que o gating abaixo vai pegar -> não escreve).
    const fasesValidas = fasesPresentesNosDados(filas, iFase);

    // 4. Extração com Sonnet (via AI Gateway se AI_GATEWAY_BASE_URL estiver setado).
    const baseURL =
      env.AI_GATEWAY_BASE_URL && env.AI_GATEWAY_BASE_URL.trim() ? env.AI_GATEWAY_BASE_URL : undefined;
    console.log(
      `[/processar] passo 4: Sonnet extrair (${fasesValidas.length} fases válidas, ${texto.length} chars)…`,
    );
    const ext = await extrairAdsDoRoteiro(env.ANTHROPIC_API_KEY, texto, fasesValidas, baseURL);
    console.log(`[/processar] passo 4 ok: ${ext.ads.length} ads extraídos, fase=${ext.fase}`);

    if (ext.ads.length === 0) {
      await ctx.reply(
        `Não escrevi nada. O modelo não identificou nenhum ad a produzir neste roteiro.` +
          (ext.notas.trim() ? `\nNotas do modelo: ${ext.notas}` : ""),
      );
      return;
    }

    // 5. Confiança-gating da extração. Estas dúvidas BLOQUEIAM a escrita mesmo
    // com --escrever (a numeração ambígua tem tratamento à parte, abaixo).
    const dudasExtracao: string[] = [];
    if (ext.confianza_fase !== "alta") {
      dudasExtracao.push(`fase "${ext.fase}" (confiança ${ext.confianza_fase})`);
    }
    ext.ads.forEach((a, i) => {
      if (a.confianza_tipo !== "alta") {
        dudasExtracao.push(`ad ${i + 1} (${a.descripcion_corta}): tipo ${a.tipo} (confiança ${a.confianza_tipo})`);
      }
    });
    // O gate bloqueia escrita SÓ quando há dúvidas de confiança reais (fase ou
    // tipo com confianza != "alta"). Antes também bloqueava se `notas` viesse
    // não-vazia, mas Sonnet usa notas pra qualquer comentário (descrições,
    // contagens, contexto) e isso causava falsos negativos. Agora notas são
    // informacionais e aparecem como rodapé nas mensagens de dry-run e sucesso.
    if (dudasExtracao.length > 0) {
      await ctx.reply(
        `Não escrevi nada${escrever ? " (mesmo com --escrever — confiança-gating)" : ""}. ` +
          `Tem coisas neste roteiro que eu não tenho certeza:\n` +
          dudasExtracao.map((d) => `• ${d}`).join("\n") +
          (ext.notas.trim() ? `\nNotas do modelo: ${ext.notas}` : "") +
          `\n\nPlano proposto: ${ext.ads.length} ad(s) de fase "${ext.fase}". ` +
          `Ajustá o roteiro (ou passá \`desde:AD<N>\` se for só a numeração) e rodá /processar de novo.`,
      );
      return;
    }

    // Notas informacionais (Sonnet pode anexar contexto mesmo com tudo "alta"):
    // mostradas no rodapé de palpite / dry-run / sucesso, não bloqueiam.
    const notasInfo = ext.notas.trim() ? `\n\nNotas do modelo: ${ext.notas}` : "";

    // 6. Abreviação da fase pro NOME: primeiro DERIVADA dos NOMEs reais dessa
    // fase na aba; se não há nenhum de onde derivar, cai pra tabela de fallback;
    // se nem isso -> dúvida, não escreve.
    const faseAbr =
      derivarFaseAbrevDosNomes(filas, iFase, iNome, ext.fase) ?? faseAbrev(ext.fase);
    if (!faseAbr) {
      await ctx.reply(
        `Não escrevi nada. Não sei a abreviação da fase "${ext.fase}" pra montar os NOMEs ` +
          `(não há filas placeholder dessa fase na aba "${aba}" de onde derivar, e não está na ` +
          `minha tabela de fallback). Me dizé o formato do NOME pra essa fase (ex.: \`AD<N>-XYZ-VID\`).`,
      );
      return;
    }

    // 7. Numeração por fase+tipo (agrupando os ads por tipo, na ordem em que aparecem).
    const tiposNaOrdem: Tipo[] = [];
    const cantPorTipo = new Map<Tipo, number>();
    for (const a of ext.ads) {
      if (!cantPorTipo.has(a.tipo)) tiposNaOrdem.push(a.tipo);
      cantPorTipo.set(a.tipo, (cantPorTipo.get(a.tipo) ?? 0) + 1);
    }

    // `desde:` só desambigua se o roteiro tem um único tipo (um número de arranque
    // não dá para dividir entre vários tipos). Se há vários tipos, ignoramos
    // `desde:` e inferimos/palpitamos cada tipo separadamente.
    const desdeAplicavel = desde !== null && tiposNaOrdem.length === 1;

    // Pra cada tipo: o arranque inferido (`max(N)+1` das filas placeholder dessa
    // fase+tipo, ou 1 se não há nenhuma) e se isso é um PALPITE (não havia
    // precedente, ou estamos respeitando um `desde:` explícito vs. um precedente).
    const planoPorTipo = new Map<Tipo, { desde: number; nomes: string[]; palpite: boolean }>();
    for (const tipo of tiposNaOrdem) {
      const cant = cantPorTipo.get(tipo)!;
      const precedente = maxNumeroPlaceholder(nomesExistentes, faseAbr, tipo);
      if (desdeAplicavel) {
        // `desde:` explícito manda; só é "palpite" se contradiz um precedente.
        const inicio = desde!;
        planoPorTipo.set(tipo, {
          desde: inicio,
          nomes: numeracaoSequencial(inicio, cant, faseAbr, tipo),
          palpite: precedente !== null && inicio !== precedente + 1,
        });
        continue;
      }
      // Sem `desde:`: inferimos. Se há precedente -> não é palpite; se não há ->
      // arrancamos em 1 e marcamos como palpite (pedimos confirmação).
      const inicio = precedente !== null ? precedente + 1 : 1;
      planoPorTipo.set(tipo, {
        desde: inicio,
        nomes: numeracaoSequencial(inicio, cant, faseAbr, tipo),
        palpite: precedente === null,
      });
    }

    // NOME final de cada ad, na ordem, consumindo a fila do seu tipo.
    const colas = new Map<Tipo, string[]>(
      [...planoPorTipo.entries()].map(([t, p]) => [t, [...p.nomes]]),
    );
    const nomesAtribuidos = ext.ads.map((a) => colas.get(a.tipo)!.shift()!);

    const docNome = (await nomeDoDoc(env, fileId)) ?? fileId;
    const haPalpite = [...planoPorTipo.values()].some((p) => p.palpite);

    // --- Linhas de re-execução ---
    // Pra um único tipo com palpite, sugerimos `desde:AD<x>` (assim o humano
    // confirma/ajusta o número). Sem palpite, só `--escrever`.
    const tokensRecorrer: string[] = [];
    if (haPalpite && tiposNaOrdem.length === 1) {
      tokensRecorrer.push(`desde:AD${planoPorTipo.get(tiposNaOrdem[0]!)!.desde}`);
    }
    const linhaConfirmar = linhaParaRecorrer(fileId, responsavel, abaArg, [...tokensRecorrer, "--escrever"]);

    const listaNomes = nomesAtribuidos.map((n) => `• ${n}`).join("\n");
    const padraoVisto = `AD<N>-${faseAbr}-<TIPO>`;

    // 8a. Há palpite (numeração/nomenclatura incerta) -> nunca escreve; pede confirmação.
    if (haPalpite) {
      const detalhePalpite = tiposNaOrdem
        .filter((t) => planoPorTipo.get(t)!.palpite)
        .map((t) => `${cantPorTipo.get(t)} ad(s) ${t} (arrancando em AD${planoPorTipo.get(t)!.desde})`)
        .join("; ");
      await ctx.reply(
        `Não escrevi nada${escrever ? " (mesmo com --escrever)" : ""}. Não tenho certeza da ` +
          `numeração nem da nomenclatura para: ${detalhePalpite} — fase "${ext.fase}", aba "${aba}".\n` +
          `Não há precedente claro nas filas existentes; meu palpite (padrão \`${padraoVisto}\`):\n` +
          listaNomes +
          `\n\nSe estiver certo, re-corra com:\n${linhaConfirmar}\n` +
          (tiposNaOrdem.length > 1
            ? `(Vários tipos no roteiro: se quiser fixar o número de um, rode uma vez por tipo passando \`desde:AD<N>\`.)\n`
            : ``) +
          `Se a nomenclatura ou o número não forem esses, me diga o formato/número correto.` +
          notasInfo,
      );
      return;
    }

    // 8b. Dry-run (sem --escrever) e nada bloqueia -> reporta o plano e a linha pra confirmar.
    if (!escrever) {
      await ctx.reply(
        `DRY-RUN — não escrevi nada (ainda). Isto é o que eu faria em "${aba}":\n` +
          `• Fase: ${ext.fase} (confiança ${ext.confianza_fase})\n` +
          `• ${ext.ads.length} fila(s), tipos: ${tiposNaOrdem.map((t) => `${t}×${cantPorTipo.get(t)}`).join(", ")}\n` +
          `• Responsável: ${responsavel || "(vazio)"}\n` +
          `• Origem (col LINK COPY): ${docNome}\n` +
          `• Status: aberto. REVISÃO/GESTOR: FALSE.\n` +
          `• NOMEs (padrão \`${padraoVisto}\` que vejo nas filas existentes):\n` +
          listaNomes +
          `\n\nSe estiver tudo certo, re-corra com:\n${linhaConfirmar}\n` +
          `Se a nomenclatura não for essa, me avise antes de confirmar.` +
          notasInfo,
      );
      return;
    }

    // 9. --escrever e nada bloqueia -> escreve de verdade.
    // Usamos `acharFilaInicio` + `escreverFilas` (values.update) em vez de
    // values.append: as Sheets do equipo tem filas pré-formatadas vazias
    // (com dropdowns mas sem valores) que o append da API conta como "parte
    // da tabela", empurrando o write 50+ filas abaixo do último dado visível.
    // values.update num range específico fica visualmente junto aos dados.
    const novasFilas = buildFilasParaSheet({
      headers,
      fase: ext.fase,
      ads: ext.ads.map((a, i) => ({ nome: nomesAtribuidos[i]!, tipo: a.tipo })),
      docNome,
      responsavel,
    });
    const filaInicio = acharFilaInicio(filas, iFase, iNome, novasFilas.length);
    console.log(`[/processar] passo 5: escreverFilas em A${filaInicio} (${novasFilas.length} filas)…`);
    const resultado = await escreverFilas(env, env.SHEET_ID, aba, filaInicio, novasFilas);
    console.log(`[/processar] passo 5 ok: ${resultado.updatedRange ?? "(sem range)"}`);

    await ctx.reply(
      `✅ Pronto. Escrevi ${novasFilas.length} fila(s) em "${aba}" (range ${resultado.updatedRange ?? `A${filaInicio}`}):\n` +
        listaNomes +
        `\nFase: ${ext.fase}. Status: aberto. Responsável: ${responsavel || "(vazio)"}. Origem: ${docNome}.\n\n` +
        `Gerei estes NOMEs seguindo o padrão \`${padraoVisto}\` que vejo nas filas existentes desta fase. ` +
        `Se a nomenclatura não for essa, me avise — posso corrigir (apagar/reescrever) se você pedir.` +
        notasInfo,
    );
  } catch (err) {
    console.error(`[/processar] erro:`, err);
    await ctx.reply(`Erro em /processar: ${mensagemDeErro(err)}`);
  }
}

// --- Helpers ---

function mensagemDeErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Maior N entre as filas placeholder (`AD<N>-<FASE>-<SUFIJO>`) dessa fase+tipo,
// ou null se não há nenhuma. Ignora as filas de arquivo finalizado (`L<leva>-…`,
// outro contador). Base do "palpite" de arranque quando não há precedente óbvio.
function maxNumeroPlaceholder(nomesExistentes: string[], faseAbr: string, tipo: Tipo): number | null {
  const ns = nomesExistentes
    .map(parseNome)
    .filter(
      (p): p is NonNullable<ReturnType<typeof parseNome>> =>
        p !== null && p.formato === "placeholder" && p.faseAbr === faseAbr && p.tipo === tipo,
    )
    .map((p) => p.n);
  return ns.length === 0 ? null : Math.max(...ns);
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
