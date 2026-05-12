import { Hono } from "hono";
import { Bot, webhookCallback } from "grammy";
import Anthropic from "@anthropic-ai/sdk";

import { tratarTesteSheet } from "./comandos/teste_sheet";
import { tratarTesteDrive } from "./comandos/teste_drive";
import { tratarProcessar, tratarListarDocs } from "./processar/comando";

// Bindings do Cloudflare Worker. Os secrets vêm de `wrangler secret put`
// (produção) ou de `.dev.vars` (local). ALLOWED_CHAT_IDS, SHEET_ID,
// DRIVE_FOLDER_ID e (opcionalmente) AI_GATEWAY_BASE_URL vêm de wrangler.toml.
interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_IDS: string;
  ANTHROPIC_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  SHEET_ID: string;
  DRIVE_FOLDER_ID: string;
  // Endpoint do Cloudflare AI Gateway para a Anthropic (opcional). "" ou ausente
  // = não configurado (cliente Anthropic direto). Ver wrangler.toml.
  AI_GATEWAY_BASE_URL?: string;
}

// Prompt de teste compartilhado pelos comandos /teste_claude e /teste_haiku.
// Hardcodeado nesta etapa: o objetivo é validar a integração end-to-end
// (Telegram -> Worker -> SDK -> Anthropic), não construir lógica de negócio.
const PROMPT_TESTE =
  "Responde em português brasileiro: o que é um lançamento digital em marketing? Responde em no máximo 3 frases.";

// IDs de modelo verificados em https://platform.claude.com/docs/en/about-claude/models
// (consulta de 2026-04-27). Trocar somente quando a doc oficial mudar.
const MODELO_SONNET = "claude-sonnet-4-6";
const MODELO_HAIKU = "claude-haiku-4-5-20251001";

// Comparação em tempo constante para o header secreto do Telegram.
// Evita timing attacks: percorre todos os bytes mesmo quando há diferença,
// acumulando o XOR em vez de retornar no primeiro byte divergente.
// Se os tamanhos diferem, devolve false sem comparar (tamanho não é segredo).
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

// Parseia "123,456,789" em Set<number>, descartando entradas inválidas.
function parseAllowedChatIds(csv: string): Set<number> {
  return new Set(
    csv
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)),
  );
}

// Extrai o chat.id do update do Telegram cobrindo os tipos mais comuns
// (mensagem, mensagem editada, callback de botão inline).
function extractChatId(update: unknown): number | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const u = update as Record<string, any>;
  return (
    u.message?.chat?.id ??
    u.edited_message?.chat?.id ??
    u.channel_post?.chat?.id ??
    u.callback_query?.message?.chat?.id
  );
}

// Helper compartilhado pelos dois comandos de teste: chama o SDK da Anthropic
// e devolve o texto da resposta. Lança em caso de erro do SDK ou de resposta
// sem bloco de texto — o caller (handler do grammY) é responsável pelo catch.
async function chamarClaude(
  apiKey: string,
  modelo: string,
  prompt: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: modelo,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  // response.content é um array de blocos (text, tool_use, thinking, ...).
  // Procuramos o primeiro bloco de texto. O type guard estreita para TextBlock.
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Resposta da API sem bloco de texto.");
  }
  return textBlock.text;
}

const app = new Hono<{ Bindings: Env }>();

// Health check manual: serve para confirmar que o deploy subiu e o Worker
// está respondendo antes mesmo de configurar o webhook do Telegram.
app.get("/", (c) => c.text("Central Controle Bot - OK"));

// Endpoint que o Telegram chama com cada update (POST /webhook).
app.post("/webhook", async (c) => {
  // 1. Validação do header secreto em tempo constante.
  // Se o secret não bate (ou não vem), respondemos 401 e abortamos.
  const headerSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!timingSafeEqual(headerSecret, c.env.TELEGRAM_WEBHOOK_SECRET)) {
    return c.body(null, 401);
  }

  // 2. Allowlist por chat_id. Lemos o body uma vez para inspecionar; o Hono
  // cacheia c.req.json(), então o webhookCallback abaixo reutiliza o mesmo
  // objeto sem reparsear.
  const update = await c.req.json();
  const chatId = extractChatId(update);
  const allowedChatIds = parseAllowedChatIds(c.env.ALLOWED_CHAT_IDS);

  if (chatId !== undefined && !allowedChatIds.has(chatId)) {
    console.warn(`Update de chat não autorizado: ${chatId}`);
    // 200 OK propositalmente: se devolvêssemos 4xx, o Telegram tentaria de
    // novo (e de novo) o mesmo update rejeitado.
    return c.body(null, 200);
  }

  // 3. Bot grammY: handler de /start + dois comandos de teste do SDK Anthropic.
  // Criado por request porque os secrets só estão disponíveis em c.env.
  const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN);

  bot.command("start", (ctx) => ctx.reply("pong"));

  // /teste_claude e /teste_haiku validam a integração com o SDK da Anthropic.
  // Resposta síncrona: prompt curto + max_tokens=300 cabe folgado no timeout
  // de 10s do Telegram. Erros são reportados ao chat e logados em wrangler tail.
  bot.command("teste_claude", async (ctx) => {
    try {
      const texto = await chamarClaude(
        c.env.ANTHROPIC_API_KEY,
        MODELO_SONNET,
        PROMPT_TESTE,
      );
      await ctx.reply(texto);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Erro em /teste_claude:", err);
      await ctx.reply(`Erro ao chamar Claude: ${msg}`);
    }
  });

  bot.command("teste_haiku", async (ctx) => {
    try {
      const texto = await chamarClaude(
        c.env.ANTHROPIC_API_KEY,
        MODELO_HAIKU,
        PROMPT_TESTE,
      );
      await ctx.reply(texto);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Erro em /teste_haiku:", err);
      await ctx.reply(`Erro ao chamar Claude: ${msg}`);
    }
  });

  // /teste_sheet e /teste_drive validam a integração com Google APIs via
  // Service Account (JWT assinado em src/google/auth.ts).
  bot.command("teste_sheet", (ctx) => tratarTesteSheet(ctx, c.env));
  bot.command("teste_drive", (ctx) => tratarTesteDrive(ctx, c.env));

  // /listar_docs e /processar — o vertical slice da Etapa 3.
  // ctx.match traz o texto depois do comando ("" se não houver).
  bot.command("listar_docs", (ctx) => tratarListarDocs(ctx, c.env));
  bot.command("processar", (ctx) => tratarProcessar(ctx, c.env, ctx.match ?? ""));

  // 4. Delegamos o processamento ao webhookCallback do grammY.
  // onTimeout: "return" responde 200 mesmo se o handler estourar o tempo
  // limite — sem isso, o default lança exceção e o Telegram reenviaria o
  // update repetidamente (retries fantasma).
  //
  // Decisão (Etapa 3, PLAN Task 7 Step 3): NÃO bloqueamos o background. /processar
  // chama Sonnet + Sheets, que pode passar de 10s; a maior parte é I/O (esperas
  // a Anthropic/Google), não CPU, então no plano Workers Paid (30s CPU) cabe.
  // Combinado com onTimeout: "return", o Worker responde 200 mesmo se demorar.
  // TODO: se em testes reais o Telegram reenviar updates de /processar (retries),
  // mover o trabalho pesado de tratarProcessar para c.executionCtx.waitUntil()
  // — devolver 200 já, e processar/responder via ctx.api fora do request.
  const handle = webhookCallback(bot, "hono", { onTimeout: "return" });
  return handle(c);
});

export default app;
