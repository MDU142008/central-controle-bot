import { Hono } from "hono";
import { Bot, webhookCallback } from "grammy";

// Bindings do Cloudflare Worker. Os dois secrets vêm de `wrangler secret put`
// (produção) ou de `.dev.vars` (local). ALLOWED_CHAT_IDS vem de wrangler.toml.
interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_IDS: string;
}

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

  // 3. Bot grammY com o único handler desta etapa: /start -> "pong".
  // Criado por request porque o token só está disponível em c.env.
  const bot = new Bot(c.env.TELEGRAM_BOT_TOKEN);
  bot.command("start", (ctx) => ctx.reply("pong"));

  // 4. Delegamos o processamento ao webhookCallback do grammY.
  // onTimeout: "return" responde 200 mesmo se o handler estourar o tempo
  // limite — sem isso, o default lança exceção e o Telegram reenviaria o
  // update repetidamente (retries fantasma).
  const handle = webhookCallback(bot, "hono", { onTimeout: "return" });
  return handle(c);
});

export default app;
