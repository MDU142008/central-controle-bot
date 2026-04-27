# central-controle-bot

Bot de Telegram para Central de Controle (agencia de marketing digital).
Etapa 1: webhook básico con `/start` → `pong`. Multi-tenant, integraciones
con Google APIs y Anthropic vienen después.

## Stack

- Cloudflare Workers (Free tier)
- TypeScript
- [Hono](https://hono.dev) — router HTTP
- [grammY](https://grammy.dev) — framework para bots de Telegram
- pnpm

## Setup local

```bash
pnpm install
cp .dev.vars.example .dev.vars
# editá .dev.vars con el token del bot dev y un webhook secret
pnpm dev
```

## Generar webhook secret

```bash
openssl rand -hex 32
```

## Deploy

```bash
wrangler login   # solo la primera vez
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm deploy
```

## Configurar webhook en Telegram

Después del deploy, registrar la URL del Worker en Telegram:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://central-controle-bot-dev.<subdomain>.workers.dev/webhook",
    "secret_token": "<EL_MISMO_QUE_PUSISTE_EN_WRANGLER>",
    "allowed_updates": ["message", "callback_query"]
  }'
```

## Verificar webhook

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## Probar

Abrir Telegram, mandarle `/start` a `@CentralControleDevBot` — tiene que
responder `pong`.
