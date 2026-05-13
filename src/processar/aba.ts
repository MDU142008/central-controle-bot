// Resolução do nome da aba destino do /processar. Princípio do projeto: o bot
// DESCOBRE qual é a aba "ads novos" na Sheet, em vez de assumir um nome fixo —
// o nome pode variar entre experts/launches (ex.: "03. ADS NOVOS", "3 ads novos",
// "Ads Novos", "03 - Ads novos"). A Etapa 4 (`/mapear`) vai fazer descoberta
// robusta com confirmação humana; na Etapa 3 fazemos um matching leve por nome
// normalizado, conservador (sem reordenar palavras nem ignorar sufixos extras).

export type ResultadoResolverAba =
  | { tipo: "achou"; titulo: string }
  | { tipo: "nenhuma" }
  | { tipo: "varias"; candidatos: string[] };

// Normaliza um título de aba pra comparação. Tira acentos, lowercase, descarta
// prefixos numéricos (`03.`, `3 `, `3-`, `03 - `, `03_`), e colapsa separadores
// internos (espaço, ponto, hífen, underscore). Conservadora: NÃO reordena
// palavras, NÃO ignora sufixos extras (ex.: "ADS NOVOS 2026" não bate).
//   "03. ADS NOVOS"   -> "ads novos"
//   "3 ads novos"     -> "ads novos"
//   "Ads Novos"       -> "ads novos"
//   "03 - Ads novos"  -> "ads novos"
//   "ADS_NOVOS"       -> "ads novos"
//   "04. ADS REAP"    -> "ads reap"        (não bate com "ads novos")
//   "ADS NOVOS 2026"  -> "ads novos 2026"  (não bate; conservadora)
export function normalizarTituloAba(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks (acentos)
    .toLowerCase()
    .replace(/^[\s\d.\-_]+/, "") // descarta prefixo numérico/separadores
    .replace(/[\s.\-_]+/g, " ") // colapsa separadores internos
    .trim();
}

// Encontra a aba "ads novos" entre os títulos reais da Sheet.
//   nenhuma -> peça pro humano dizer qual é com `aba:<nome>` (ou renomeie a aba).
//   varias  -> ambíguo (raríssimo, ex.: a Sheet tem duas variações); peça escolha.
//   achou   -> usa esse título exato pra ler/escrever.
export function resolverAbaAdsNovos(titulos: string[]): ResultadoResolverAba {
  const matches = titulos.filter((t) => normalizarTituloAba(t) === "ads novos");
  if (matches.length === 0) return { tipo: "nenhuma" };
  if (matches.length === 1) return { tipo: "achou", titulo: matches[0]! };
  return { tipo: "varias", candidatos: matches };
}
