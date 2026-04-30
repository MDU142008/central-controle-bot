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

## Configurar Google Service Account

El bot usa una Service Account de Google para acceder a Sheets y Drive.

### Crear la SA (una sola vez)

1. Crear proyecto en https://console.cloud.google.com.
2. Habilitar Google Sheets API y Google Drive API.
3. IAM y administración → Cuentas de servicio → Crear.
4. Descargar la JSON key (Claves → Agregar clave → JSON).
5. Guardar el archivo en una ubicación segura, fuera del repo.

### Compartir recursos con la SA

El email de la SA está en el JSON, campo `client_email`. Tiene forma:
`<nombre>@<proyecto>.iam.gserviceaccount.com`.

- Sheet: compartir como Editor (necesario para escribir ads en etapas futuras).
- Carpeta Drive: compartir como Lector (alcanza para leer roteiros).

Destildar "Notificar pessoas" al compartir (la SA no tiene inbox).

## Deploy

```bash
wrangler login   # solo la primera vez
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm deploy
```

### Secrets de Etapa 2

```powershell
# Anthropic API key
pnpm exec wrangler secret put ANTHROPIC_API_KEY

# Google Service Account JSON (archivo entero, usar -Raw para preservar saltos de línea)
Get-Content "ruta\al\service-account.json" -Raw | pnpm exec wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

### Vars (en wrangler.toml)

Editar `[vars]` en `wrangler.toml`:

```toml
[vars]
ALLOWED_CHAT_IDS = "..."
SHEET_ID = ""
DRIVE_FOLDER_ID = ""
```

Los IDs salen de las URLs de Google. SHEET_ID y DRIVE_FOLDER_ID no son secretos —
sin compartir el recurso con la SA no sirven de nada.

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

## Comandos del bot

- `/start` — health check, responde "pong".
- `/teste_claude` — manda prompt de prueba a Sonnet 4.6, devuelve respuesta.
- `/teste_haiku` — idem con Haiku 4.5.
- `/teste_sheet` — lee la primera fila de la Sheet configurada.
- `/teste_drive` — lista archivos en la carpeta de Drive configurada (solo hijos directos, no recursivo).

## Probar

Abrir Telegram, mandarle `/start` a `@CentralControleDevBot` — tiene que
responder `pong`.
