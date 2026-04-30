import type { Context } from "grammy";

import { listarArquivosNaPasta } from "../google/drive";

interface TesteDriveEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  DRIVE_FOLDER_ID: string;
}

// Handler do comando /teste_drive: valida a integração com a Drive API
// listando os arquivos diretos da pasta configurada (não recursivo).
export async function tratarTesteDrive(
  ctx: Context,
  env: TesteDriveEnv,
): Promise<void> {
  try {
    const arquivos = await listarArquivosNaPasta(env, env.DRIVE_FOLDER_ID);

    if (arquivos.length === 0) {
      await ctx.reply("Pasta vazia ou sem arquivos visíveis para a SA.");
      return;
    }

    const lista = arquivos
      .map((arq) => `- ${arq.name} (id: ${arq.id})`)
      .join("\n");

    await ctx.reply(`Arquivos na pasta (${arquivos.length}):\n${lista}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Erro em /teste_drive:", err);
    await ctx.reply(`Erro ao chamar Google Drive: ${msg}`);
  }
}
