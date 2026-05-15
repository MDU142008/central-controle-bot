// Comandos /teste_d1 (sync on-demand + report) e /status_d1 (consulta o último
// sync sem disparar nada). Validam que D1 está vivo, o schema está aplicado,
// o sync funciona, e os contadores fazem sentido vs. a Sheet.

import type { Context } from "grammy";
import { sincronizarAdsNovos, ultimoSync, contadoresAds, type SyncEnv } from "../d1/sync";

export async function tratarTesteD1(ctx: Context, env: SyncEnv): Promise<void> {
  if (!env.DB) {
    await ctx.reply(
      "D1 não está configurado. Precisa do binding `DB` em wrangler.toml + " +
        "schema aplicado via `wrangler d1 execute ... --file migrations/001-initial.sql`.",
    );
    return;
  }

  await ctx.reply("Disparando sync (Sheet → D1)…");
  try {
    const res = await sincronizarAdsNovos(env, "teste_d1");
    if (!res.ok) {
      await ctx.reply(`❌ Sync falhou: ${res.errorMsg}\nDuração: ${res.durationMs}ms`);
      return;
    }
    const conts = await contadoresAds(env.DB);
    const fases = conts.porFase
      .slice(0, 8)
      .map((f) => `  • ${f.fase ?? "(vazia)"}: ${f.count}`)
      .join("\n");
    const statuses = conts.porStatus
      .slice(0, 8)
      .map((s) => `  • ${s.status ?? "(vazia)"}: ${s.count}`)
      .join("\n");
    await ctx.reply(
      `✅ Sync ok. Aba "${res.sourceAba}", ${res.rowsSynced} fila(s) em ${res.durationMs}ms.\n\n` +
        `Tabela ads (D1):\n` +
        `Total: ${conts.total}\n\n` +
        `Por FASE:\n${fases || "  (vazio)"}\n\n` +
        `Por STATUS:\n${statuses || "  (vazio)"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/teste_d1] erro:", err);
    await ctx.reply(`Erro em /teste_d1: ${msg}`);
  }
}

export async function tratarStatusD1(ctx: Context, env: SyncEnv): Promise<void> {
  if (!env.DB) {
    await ctx.reply("D1 não está configurado (binding `DB` ausente).");
    return;
  }
  try {
    const last = await ultimoSync(env.DB);
    if (!last) {
      await ctx.reply(
        "Nenhum sync registrado ainda. Rode /teste_d1 ou aguarde o cron (cada 5 min).",
      );
      return;
    }
    const conts = await contadoresAds(env.DB);
    await ctx.reply(
      `Último sync: ${last.ranAt}\n` +
        `Trigger: ${last.trigger}\n` +
        `Status: ${last.status}\n` +
        `Aba: ${last.sourceAba ?? "(none)"}\n` +
        `Linhas: ${last.rowsSynced}\n` +
        `Duração: ${last.durationMs ?? "?"}ms\n` +
        (last.errorMsg ? `Erro: ${last.errorMsg}\n` : "") +
        `\nTotal em ads: ${conts.total}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/status_d1] erro:", err);
    await ctx.reply(`Erro em /status_d1: ${msg}`);
  }
}
