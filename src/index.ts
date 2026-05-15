import { Hono } from "hono";
import { Bot, webhookCallback } from "grammy";
import Anthropic from "@anthropic-ai/sdk";

import { tratarTesteSheet } from "./comandos/teste_sheet";
import { tratarTesteDrive } from "./comandos/teste_drive";
import { tratarTesteD1, tratarStatusD1 } from "./comandos/teste_d1";
import { tratarProcessar, tratarListarDocs } from "./processar/comando";
import { sincronizarAdsNovos } from "./d1/sync";

// Bindings do Cloudflare Worker. Os secrets vêm de `wrangler secret put`
// (produção) ou de `.dev.vars` (local). ALLOWED_CHAT_IDS, SHEET_ID,
// DRIVE_FOLDER_ID e (opcionalmente) AI_GATEWAY_BASE_URL vêm de wrangler.toml.
// DB (D1 binding) vem de [[d1_databases]] em wrangler.toml; opcional pra
// permitir deploy antes de criar a D1 — os comandos /teste_d1, /status_d1 e
// o cron `scheduled` se autoprotegem se DB for undefined.
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
  // D1 mirror de "03. ADS NOVOS" (Etapa 5). Opcional até a DB ser criada.
  DB?: D1Database;
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
// Se baseURL vier (AI_GATEWAY_BASE_URL setado), a chamada passa pelo Cloudflare
// AI Gateway (logging + métricas); se vier vazio/undefined, vai direto à API.
async function chamarClaude(
  apiKey: string,
  modelo: string,
  prompt: string,
  baseURL?: string,
): Promise<string> {
  const client = new Anthropic(baseURL ? { apiKey, baseURL } : { apiKey });
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
        c.env.AI_GATEWAY_BASE_URL,
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
        c.env.AI_GATEWAY_BASE_URL,
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

  // /teste_d1 dispara um sync Sheet → D1 sob demanda e reporta contadores.
  // /status_d1 consulta o último sync sem disparar nada. Self-check do mirror.
  bot.command("teste_d1", (ctx) => {
    if (!c.env.DB) {
      return ctx.reply("D1 não configurado. Crie a DB e adicione o binding em wrangler.toml.");
    }
    c.executionCtx.waitUntil(
      tratarTesteD1(ctx, c.env as Required<Pick<Env, "DB">> & Env).catch((err) =>
        console.error("[/teste_d1] erro não capturado:", err),
      ),
    );
  });
  bot.command("status_d1", (ctx) => tratarStatusD1(ctx, c.env as Required<Pick<Env, "DB">> & Env));

  // /listar_docs e /processar — o vertical slice da Etapa 3.
  // ctx.match traz o texto depois do comando ("" se não houver).
  bot.command("listar_docs", (ctx) => tratarListarDocs(ctx, c.env));

  // /processar usa c.executionCtx.waitUntil() pra sobreviver ao timeout de 10s
  // do webhookCallback. Sem isso, o Worker era terminado depois que o handler
  // do grammY "retornava" no timeout — a chamada a Sonnet completava (gastando
  // crédito da API) mas o nosso código que escreve na Sheet e responde ao chat
  // nunca rodava (bug detectado 2026-05-13 com logs em wrangler tail). O
  // catch interno de tratarProcessar trata erros; o .catch aqui é defense-in-
  // depth caso o próprio ctx.reply do catch falhe (Telegram down etc.).
  bot.command("processar", (ctx) => {
    c.executionCtx.waitUntil(
      tratarProcessar(ctx, c.env, ctx.match ?? "").catch((err) => {
        console.error("[/processar] erro não capturado no waitUntil:", err);
      }),
    );
  });

  // 4. Delegamos o processamento ao webhookCallback do grammY.
  // onTimeout: "return" responde 200 mesmo se o handler estourar o tempo
  // limite — sem isso, o default lança exceção e o Telegram reenviaria o
  // update repetidamente (retries fantasma). Combinado com o waitUntil de
  // /processar acima, o Worker responde 200 a Telegram em ≤10s e segue
  // processando em background até terminar (sem ser morto pela Cloudflare).
  const handle = webhookCallback(bot, "hono", { onTimeout: "return" });
  return handle(c);
});

// Cron Trigger (cada 5 min via wrangler.toml). Dispara o sync Sheet → D1.
// `ctx.waitUntil` mantém o Worker vivo até `sincronizarAdsNovos` resolver
// (cron handlers têm 30s de CPU + waitUntil — folgado pra um sync típico).
// Se a DB não está configurada (binding ausente), pula silenciosamente
// — o cron continua rodando mas no-op, sem ruído nos logs.
async function rodarCronSync(env: Env, ctx: ExecutionContext): Promise<void> {
  if (!env.DB) {
    console.log("[scheduled] DB binding ausente, skip do sync");
    return;
  }
  ctx.waitUntil(
    sincronizarAdsNovos(env as Env & { DB: D1Database }, "cron")
      .then((res) => {
        if (!res.ok) {
          console.error(`[scheduled] sync error: ${res.errorMsg}`);
        } else {
          console.log(
            `[scheduled] sync ok: aba="${res.sourceAba}", ${res.rowsSynced} linhas em ${res.durationMs}ms`,
          );
        }
      })
      .catch((err) => console.error("[scheduled] sync threw:", err)),
  );
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    void rodarCronSync(env, ctx);
  },
} satisfies ExportedHandler<Env>;
