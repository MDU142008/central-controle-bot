// Extração estruturada do roteiro com Sonnet, via `tool_use` forçado.
//
// Passamos ao modelo: o texto do roteiro + a lista de fases válidas — derivada
// dos DADOS REAIS da aba (col FASE das filas existentes), não hardcodeada. Se a
// lista vier vazia (aba nova sem dados), o prompt instrui o modelo a usar a fase
// do briefing tal qual e marcar `confianza_fase: "media"` (para um humano
// confirmar; o handler de /processar não escreve com confiança != "alta").
// Forçamos a chamada de uma única tool `registrar_ads` — assim a resposta vem
// garantidamente como um objeto estruturado, não como texto livre.
//
// Decisões (ver MASTER.md / PLAN-etapa3):
//   - Modelo: "claude-sonnet-4-6" (alias, sem pin de snapshot — decisão consciente
//     para dev; pinea-se na Etapa 8).
//   - Cliente Anthropic: `new Anthropic({ apiKey })` direto, OU `new Anthropic({
//     apiKey, baseURL })` se um `baseURL` (Cloudflare AI Gateway) é passado — ver
//     o parâmetro `baseURL` de `extrairAdsDoRoteiro`. O request em si não muda.
//   - Caching de prompt, evals etc. ficam para a Etapa 8.
//
// O `tipo` de cada ad o modelo infere do briefing (vídeo/video/reel -> VID;
// estático/imagem/feed/stories -> EST; carrossel/carrusel/cards -> CAR). Se um ad
// é ambíguo, o modelo marca `confianza_tipo: "media"` ou `"baja"` e explica em
// `notas` — o handler usa isso para decidir se escreve ou pergunta.

import Anthropic from "@anthropic-ai/sdk";
import type { Tipo } from "./numeracao";

const MODELO_SONNET = "claude-sonnet-4-6";

// Tool única que o modelo é forçado a chamar. O input_schema descreve a
// extração que esperamos. `as const` para que o tipo do nome seja literal
// ("registrar_ads"), o que o teste compara diretamente.
export const TOOL_REGISTRAR_ADS = {
  name: "registrar_ads",
  description: "Registra os ads que o roteiro pede para produzir, com a fase e o tipo de cada um.",
  input_schema: {
    type: "object" as const,
    properties: {
      fase: {
        type: "string",
        description: "A fase do briefing. DEVE ser exatamente um dos valores válidos passados no prompt.",
      },
      confianza_fase: { type: "string", enum: ["alta", "media", "baja"] },
      ads: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tipo: {
              type: "string",
              enum: ["VID", "EST", "CAR"],
              description: "VID=vídeo, EST=estático/imagem, CAR=carrossel",
            },
            confianza_tipo: { type: "string", enum: ["alta", "media", "baja"] },
            descripcion_corta: {
              type: "string",
              description: "1 frase identificando o ad (ex.: 'ad ganhador 3', 'variação focada no público 1').",
            },
          },
          required: ["tipo", "confianza_tipo", "descripcion_corta"],
        },
      },
      notas: {
        type: "string",
        description: "O que ficou duvidoso ou ambíguo, se algo. Vazio se tudo claro.",
      },
    },
    required: ["fase", "confianza_fase", "ads", "notas"],
  },
} as const;

export interface RequestExtracao {
  model: string;
  max_tokens: number;
  tools: (typeof TOOL_REGISTRAR_ADS)[];
  tool_choice: { type: "tool"; name: string };
  messages: { role: "user"; content: string }[];
}

// Monta o request para a API. Separado da chamada real para que os testes
// possam exercitar o armado sem tocar a rede.
// `fasesValidas` vem dos dados reais da aba. Se vier vazia, instruímos o modelo
// a usar a fase do briefing tal qual com confiança "media" (não há lista contra
// a qual validar — quem confirma é um humano).
export function construirRequestExtracao(textoRoteiro: string, fasesValidas: string[]): RequestExtracao {
  const instrucaoFase =
    fasesValidas.length > 0
      ? `Fases válidas (use exatamente uma destas strings em "fase"): ${fasesValidas.join(", ")}. ` +
        `Se o briefing não bate claramente com nenhuma, escolha a mais próxima e marque confianza_fase "media" ou "baja", explicando em "notas".`
      : `Não tenho uma lista de fases válidas (a aba destino está sem dados). Use a fase como aparece no briefing, em minúsculas, e marque SEMPRE confianza_fase "media" (um humano vai confirmar a nomenclatura).`;
  const conteudo =
    `Você é um assistente que lê briefings de criativos publicitários e extrai os ads a produzir.\n` +
    `${instrucaoFase}\n` +
    `Regras para "tipo": se o briefing menciona vídeo/video/reel -> VID; estático/imagem/feed/stories -> EST; carrossel/carrusel/cards -> CAR.\n` +
    `Se você NÃO consegue determinar a fase, ou o tipo de algum ad, com segurança, marque a confiança "media" ou "baja" e explique em "notas". Não invente.\n\n` +
    `=== ROTEIRO ===\n${textoRoteiro}`;
  return {
    model: MODELO_SONNET,
    max_tokens: 2048,
    tools: [TOOL_REGISTRAR_ADS],
    tool_choice: { type: "tool", name: "registrar_ads" },
    messages: [{ role: "user", content: conteudo }],
  };
}

export interface AdExtraido {
  tipo: Tipo;
  confianza_tipo: "alta" | "media" | "baja";
  descripcion_corta: string;
}

export interface Extracao {
  fase: string;
  confianza_fase: "alta" | "media" | "baja";
  ads: AdExtraido[];
  notas: string;
}

// Extrai o bloco tool_use da resposta. Lança se o modelo não devolveu a tool
// esperada (não deveria acontecer com tool_choice forçado, mas defendemos).
export function parsearRespostaExtracao(resp: Anthropic.Message): Extracao {
  const block = resp.content.find((b) => b.type === "tool_use" && b.name === "registrar_ads");
  if (!block || block.type !== "tool_use") {
    throw new Error("Sonnet não devolveu o tool_use registrar_ads.");
  }
  return block.input as Extracao;
}

// Faz a chamada real à API. Usado pelo handler de /processar; os testes não o
// chamam (eles testam construirRequestExtracao / parsearRespostaExtracao).
//
// `baseURL` (opcional): se passado e não-vazio, o cliente Anthropic aponta para
// esse endpoint — é assim que ligamos o Cloudflare AI Gateway (caché de
// requests + logging de prompts/respostas + tracking de custo). O endpoint tem a
// forma `https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/<GATEWAY_NAME>/anthropic`;
// o SDK acrescenta `/v1/messages` sozinho, e a API key segue indo no header
// normal (o gateway a reenvia). Se não vier `baseURL`, cliente direto, como antes.
export async function extrairAdsDoRoteiro(
  apiKey: string,
  textoRoteiro: string,
  fasesValidas: string[],
  baseURL?: string,
): Promise<Extracao> {
  const client = baseURL && baseURL.trim() ? new Anthropic({ apiKey, baseURL }) : new Anthropic({ apiKey });
  const req = construirRequestExtracao(textoRoteiro, fasesValidas);
  // `req` é um subconjunto bem-formado dos parâmetros de messages.create; o
  // cast evita ter que reproduzir toda a tipagem da SDK aqui.
  const resp = await client.messages.create(req as unknown as Anthropic.MessageCreateParamsNonStreaming);
  return parsearRespostaExtracao(resp);
}
