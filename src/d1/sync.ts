// Etapa 5 — sincronização Sheet -> D1 mirror.
//
// Disparado por:
//   - Cron Trigger a cada 5 min (ver wrangler.toml + scheduled handler em index.ts).
//   - Comando /teste_d1 (ver src/comandos/teste_d1.ts) — sync on-demand + report.
//   - Apps Script onEdit -> webhook (Etapa 9, complementar; sync imediato).
//
// Estratégia: descobre a aba "ads novos" via acharAba (matching difuso, mesmo
// código que /processar usa), lê headers + filas via Sheets API, faz upsert
// por (source_aba, source_row) em batches. Filas vazias (sem FASE nem NOME)
// são puladas. Não deletamos linhas que sumiram da Sheet — uma stale-row sweep
// fica para Etapa 8 (idempotency/cleanup formal).

import { listarAbas, lerHeaders, lerFilas } from "../google/sheets";
import { resolverAbaAdsNovos } from "../processar/aba";
import type { AuthEnv } from "../google/auth";

export interface SyncEnv extends AuthEnv {
  DB: D1Database;
  SHEET_ID: string;
}

export interface SyncResult {
  ok: boolean;
  rowsSynced: number;
  sourceAba: string | null;
  errorMsg?: string;
  durationMs: number;
}

export interface AdRow {
  source_aba: string;
  source_row: number;
  fase: string | null;
  nome: string | null;
  copy_status: string | null;
  link_copy: string | null;
  design_ou_edicao: string | null;
  status: string | null;
  responsavel: string | null;
  link_ads_finalizado: string | null;
  revisao_final: number | null;
  gestor_de_ads_recebeu: number | null;
}

// Converte um valor de célula em boolean integer (0/1) ou null se ambíguo.
// Sheets com USER_ENTERED retornam "TRUE"/"FALSE" pra checkboxes; outros
// idiomas podem vir como "Sim"/"Não" / "Verdadeiro"/"Falso". Tolerante:
// se não bate nada, devolve null (em vez de assumir false).
export function parseBoolFlexivel(v: string): number | null {
  const t = v.trim().toLowerCase();
  if (!t) return null;
  if (["true", "1", "verdadeiro", "sim", "yes", "verdadero"].includes(t)) return 1;
  if (["false", "0", "falso", "não", "nao", "no"].includes(t)) return 0;
  return null;
}

// Mapeia headers + uma fila do Sheet -> AdRow.
// Lookup por nome de header (case-insensitive, trim), tolerante a ordem.
// A coluna "LINK COPY" não tem header próprio na linha 1 — é a sub-coluna
// imediatamente após "COPY" (mesma convenção de filas.ts).
export function filaParaAdRow(
  headers: string[],
  fila: string[],
  sourceAba: string,
  sourceRow: number,
): AdRow {
  const idx = (h: string): number =>
    headers.findIndex((x) => x.trim().toLowerCase() === h.toLowerCase());
  const get = (h: string): string => {
    const i = idx(h);
    return i >= 0 ? (fila[i] ?? "").trim() : "";
  };
  const iCopy = idx("COPY");
  const linkCopy = iCopy >= 0 ? (fila[iCopy + 1] ?? "").trim() : "";

  return {
    source_aba: sourceAba,
    source_row: sourceRow,
    fase: get("FASE") || null,
    nome: get("NOME") || null,
    copy_status: get("COPY") || null,
    link_copy: linkCopy || null,
    design_ou_edicao: get("DESIGN OU EDIÇÃO") || null,
    status: get("STATUS") || null,
    responsavel: get("RESPONSÁVEL") || null,
    link_ads_finalizado: get("LINK ADS FINALIZADO") || null,
    revisao_final: parseBoolFlexivel(get("REVISÃO FINAL")),
    gestor_de_ads_recebeu: parseBoolFlexivel(get("GESTOR DE ADS RECEBEU")),
  };
}

// Heurística "fila vazia": col FASE + col NOME ambas vazias = não vale
// sincronizar. Mesma convenção de acharFilaInicio em sheets.ts.
export function filaEhVazia(row: AdRow): boolean {
  return !row.fase && !row.nome;
}

export type TriggerSync = "cron" | "teste_d1" | "manual";

// Executa o sync end-to-end. NÃO lança em caso de erro — devolve o resultado
// no SyncResult (com ok=false + errorMsg). Para o cron, isso evita que um
// erro de uma execução tire o cron de produção.
export async function sincronizarAdsNovos(
  env: SyncEnv,
  trigger: TriggerSync = "cron",
): Promise<SyncResult> {
  const start = Date.now();
  const ranAt = new Date().toISOString();
  let sourceAba: string | null = null;

  try {
    // 1. Resolve a aba destino (mesma lógica de /processar: descobre, não assume).
    const abas = await listarAbas(env, env.SHEET_ID);
    const resolved = resolverAbaAdsNovos(abas.map((a) => a.title));
    if (resolved.tipo !== "achou") {
      const msg =
        resolved.tipo === "nenhuma"
          ? "Nenhuma aba parecida com 'ads novos' achada"
          : `Múltiplas abas batem 'ads novos': ${resolved.candidatos.join(", ")}`;
      await logSync(env.DB, ranAt, trigger, null, 0, "error", msg, Date.now() - start);
      return {
        ok: false,
        rowsSynced: 0,
        sourceAba: null,
        errorMsg: msg,
        durationMs: Date.now() - start,
      };
    }
    sourceAba = resolved.titulo;

    // 2. Lê headers + filas.
    const headers = await lerHeaders(env, env.SHEET_ID, sourceAba);
    if (headers.length === 0) {
      const msg = `Aba "${sourceAba}" sem cabeçalhos`;
      await logSync(env.DB, ranAt, trigger, sourceAba, 0, "error", msg, Date.now() - start);
      return {
        ok: false,
        rowsSynced: 0,
        sourceAba,
        errorMsg: msg,
        durationMs: Date.now() - start,
      };
    }
    const filas = await lerFilas(env, env.SHEET_ID, sourceAba);

    // 3. Upsert cada fila não-vazia.
    const lastSyncedAt = new Date().toISOString();
    let count = 0;
    for (let i = 0; i < filas.length; i++) {
      const adRow = filaParaAdRow(headers, filas[i] ?? [], sourceAba, i + 2);
      if (filaEhVazia(adRow)) continue;
      await upsertAdRow(env.DB, adRow, lastSyncedAt);
      count++;
    }

    await logSync(env.DB, ranAt, trigger, sourceAba, count, "ok", null, Date.now() - start);
    return {
      ok: true,
      rowsSynced: count,
      sourceAba,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Best-effort log; se o próprio D1 está down, ao menos retornamos.
    await logSync(env.DB, ranAt, trigger, sourceAba, 0, "error", msg, Date.now() - start).catch(
      () => {},
    );
    return {
      ok: false,
      rowsSynced: 0,
      sourceAba,
      errorMsg: msg,
      durationMs: Date.now() - start,
    };
  }
}

// Upsert via ON CONFLICT — mantém o id estável, só atualiza colunas mudadas.
// As triggers de FTS5 (ads_au) cuidam de re-sincronizar ads_fts.
async function upsertAdRow(db: D1Database, row: AdRow, lastSyncedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ads (source_aba, source_row, fase, nome, copy_status, link_copy,
                        design_ou_edicao, status, responsavel, link_ads_finalizado,
                        revisao_final, gestor_de_ads_recebeu, last_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(source_aba, source_row) DO UPDATE SET
         fase = excluded.fase,
         nome = excluded.nome,
         copy_status = excluded.copy_status,
         link_copy = excluded.link_copy,
         design_ou_edicao = excluded.design_ou_edicao,
         status = excluded.status,
         responsavel = excluded.responsavel,
         link_ads_finalizado = excluded.link_ads_finalizado,
         revisao_final = excluded.revisao_final,
         gestor_de_ads_recebeu = excluded.gestor_de_ads_recebeu,
         last_synced_at = excluded.last_synced_at`,
    )
    .bind(
      row.source_aba,
      row.source_row,
      row.fase,
      row.nome,
      row.copy_status,
      row.link_copy,
      row.design_ou_edicao,
      row.status,
      row.responsavel,
      row.link_ads_finalizado,
      row.revisao_final,
      row.gestor_de_ads_recebeu,
      lastSyncedAt,
    )
    .run();
}

async function logSync(
  db: D1Database,
  ranAt: string,
  trigger: string,
  sourceAba: string | null,
  rowsSynced: number,
  status: "ok" | "error",
  errorMsg: string | null,
  durationMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO _sync_log (ran_at, trigger, source_aba, rows_synced, status, error_msg, duration_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(ranAt, trigger, sourceAba, rowsSynced, status, errorMsg, durationMs)
    .run();
}

// --- Queries de leitura para /teste_d1 e /status_d1 ---

export interface UltimoSync {
  ranAt: string;
  trigger: string;
  sourceAba: string | null;
  rowsSynced: number;
  status: string;
  errorMsg: string | null;
  durationMs: number | null;
}

export async function ultimoSync(db: D1Database): Promise<UltimoSync | null> {
  const result = await db
    .prepare(
      `SELECT ran_at, trigger, source_aba, rows_synced, status, error_msg, duration_ms
       FROM _sync_log
       ORDER BY id DESC
       LIMIT 1`,
    )
    .first<{
      ran_at: string;
      trigger: string;
      source_aba: string | null;
      rows_synced: number;
      status: string;
      error_msg: string | null;
      duration_ms: number | null;
    }>();
  if (!result) return null;
  return {
    ranAt: result.ran_at,
    trigger: result.trigger,
    sourceAba: result.source_aba,
    rowsSynced: result.rows_synced,
    status: result.status,
    errorMsg: result.error_msg,
    durationMs: result.duration_ms,
  };
}

export interface ContadoresAds {
  total: number;
  porFase: { fase: string | null; count: number }[];
  porStatus: { status: string | null; count: number }[];
}

export async function contadoresAds(db: D1Database): Promise<ContadoresAds> {
  const total = await db.prepare(`SELECT COUNT(*) as c FROM ads`).first<{ c: number }>();
  const porFase = await db
    .prepare(`SELECT fase, COUNT(*) as c FROM ads GROUP BY fase ORDER BY c DESC`)
    .all<{ fase: string | null; c: number }>();
  const porStatus = await db
    .prepare(`SELECT status, COUNT(*) as c FROM ads GROUP BY status ORDER BY c DESC`)
    .all<{ status: string | null; c: number }>();
  return {
    total: total?.c ?? 0,
    porFase: (porFase.results ?? []).map((r) => ({ fase: r.fase, count: r.c })),
    porStatus: (porStatus.results ?? []).map((r) => ({ status: r.status, count: r.c })),
  };
}
