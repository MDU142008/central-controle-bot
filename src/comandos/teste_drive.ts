import type { Context } from "grammy";

import { listarDocsRecursivo } from "../google/drive";

interface TesteDriveEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  DRIVE_FOLDER_ID: string;
}

// Handler do comando /teste_drive: valida a integração com a Drive API
// listando recursivamente todos os Google Docs sob a pasta configurada,
// cada um com o seu caminho relativo. (Smoke check da Etapa 2; o /listar_docs
// "de verdade" da Etapa 3 vai usar a mesma função.)
export async function tratarTesteDrive(ctx: Context, env: TesteDriveEnv): Promise<void> {
  try {
    const docs = await listarDocsRecursivo(env, env.DRIVE_FOLDER_ID);

    if (docs.length === 0) {
      await ctx.reply(
        "Nenhum Google Doc encontrado sob a pasta configurada (ou a SA não tem acesso).",
      );
      return;
    }

    const lista = docs.map((d) => `- ${d.path} (id: ${d.id})`).join("\n");
    const texto = `Google Docs sob a pasta (${docs.length}):\n${lista}`;

    // Telegram corta mensagens em ~4096 chars; manda em blocos se preciso.
    for (let i = 0; i < texto.length; i += 3500) {
      await ctx.reply(texto.slice(i, i + 3500));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Erro em /teste_drive:", err);
    await ctx.reply(`Erro ao chamar Google Drive: ${msg}`);
  }
}
