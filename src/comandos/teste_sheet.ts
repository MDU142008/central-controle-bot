import type { Context } from "grammy";

import { lerPrimeiraLinha } from "../google/sheets";

// Subconjunto do Env que este handler precisa.
interface TesteSheetEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  SHEET_ID: string;
}

// Handler do comando /teste_sheet: valida a integração com a Sheets API
// lendo a primeira linha da planilha configurada e devolvendo cada célula
// rotulada por sua coluna.
export async function tratarTesteSheet(
  ctx: Context,
  env: TesteSheetEnv,
): Promise<void> {
  try {
    const linha = await lerPrimeiraLinha(env, env.SHEET_ID);

    if (linha.length === 0) {
      await ctx.reply("Sheet vazia ou sem dados na primeira linha.");
      return;
    }

    const formatado = linha
      .map((valor, i) => {
        // A-Z para as 26 primeiras colunas; a partir daí cai para índice numérico.
        const rotulo =
          i < 26 ? `Coluna ${String.fromCharCode(65 + i)}` : `Coluna ${i + 1}`;
        return `${rotulo}: ${valor}`;
      })
      .join("\n");

    await ctx.reply(`Primeira linha da Sheet:\n${formatado}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Erro em /teste_sheet:", err);
    await ctx.reply(`Erro ao chamar Google Sheets: ${msg}`);
  }
}
