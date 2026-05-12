import { describe, it, expect } from "vitest";
import {
  construirRequestExtracao,
  parsearRespostaExtracao,
  TOOL_REGISTRAR_ADS,
} from "../src/processar/extrair";

// Estes testes NÃO chamam a API real — exercitam o armado do request e o parsing
// de respostas canônicas (tool_use blocks).

describe("construirRequestExtracao", () => {
  it("usa o modelo Sonnet, tool_choice forçado, inclui a tool e as fases válidas + o roteiro no prompt", () => {
    const req = construirRequestExtracao("texto do roteiro aqui", ["captação", "aquecimento"]);
    expect(req.model).toBe("claude-sonnet-4-6");
    expect(req.tool_choice).toEqual({ type: "tool", name: "registrar_ads" });
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]).toBe(TOOL_REGISTRAR_ADS);
    const messagesJson = JSON.stringify(req.messages);
    expect(messagesJson).toContain("captação");
    expect(messagesJson).toContain("aquecimento");
    expect(messagesJson).toContain("texto do roteiro aqui");
    expect(req.messages[0]!.role).toBe("user");
  });

  it("com fasesValidas vazia (aba sem dados), instrui o modelo a usar a fase do briefing com confiança media", () => {
    const req = construirRequestExtracao("texto", []);
    const messagesJson = JSON.stringify(req.messages);
    expect(messagesJson).toContain("media");
    // não menciona "Fases válidas" porque não há lista contra a qual validar
    expect(messagesJson).not.toContain("Fases válidas");
  });

  it("o input_schema da tool exige fase, confianza_fase, ads e notas", () => {
    expect(TOOL_REGISTRAR_ADS.name).toBe("registrar_ads");
    expect(TOOL_REGISTRAR_ADS.input_schema.required).toEqual([
      "fase",
      "confianza_fase",
      "ads",
      "notas",
    ]);
    // os itens de `ads` têm tipo enum VID/EST/CAR
    const itemEnum = (TOOL_REGISTRAR_ADS.input_schema.properties.ads as any).items.properties.tipo
      .enum;
    expect(itemEnum).toEqual(["VID", "EST", "CAR"]);
  });
});

describe("parsearRespostaExtracao", () => {
  it("extrai o tool_use block registrar_ads", () => {
    const resp = {
      content: [
        {
          type: "tool_use",
          name: "registrar_ads",
          input: {
            fase: "captação",
            confianza_fase: "alta",
            ads: [
              { tipo: "VID", confianza_tipo: "alta", descripcion_corta: "ad ganhador 3" },
              { tipo: "VID", confianza_tipo: "alta", descripcion_corta: "ad ganhador 1" },
            ],
            notas: "",
          },
        },
      ],
    } as any;
    const r = parsearRespostaExtracao(resp);
    expect(r.fase).toBe("captação");
    expect(r.confianza_fase).toBe("alta");
    expect(r.ads).toHaveLength(2);
    expect(r.ads[0]!.tipo).toBe("VID");
    expect(r.notas).toBe("");
  });

  it("ignora blocos que não sejam o tool_use esperado e pega o certo", () => {
    const resp = {
      content: [
        { type: "text", text: "pensando..." },
        {
          type: "tool_use",
          name: "registrar_ads",
          input: { fase: "aquecimento", confianza_fase: "media", ads: [], notas: "roteiro vago" },
        },
      ],
    } as any;
    const r = parsearRespostaExtracao(resp);
    expect(r.fase).toBe("aquecimento");
    expect(r.confianza_fase).toBe("media");
    expect(r.notas).toBe("roteiro vago");
  });

  it("lança se a resposta não traz o tool_use registrar_ads", () => {
    expect(() => parsearRespostaExtracao({ content: [{ type: "text", text: "nada" }] } as any)).toThrow(
      /registrar_ads/,
    );
    expect(() =>
      parsearRespostaExtracao({
        content: [{ type: "tool_use", name: "outra_tool", input: {} }],
      } as any),
    ).toThrow();
  });
});
