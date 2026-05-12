// Numeração dos `NOME` das filas novas de `03. ADS NOVOS` e parsing dos NOMEs
// existentes para inferir o próximo número.
//
// Contexto (de references/sheet-structure.md, launch real FEV 26):
//   - As filas "placeholder" (status aberto, ainda não gravadas) usam o NOME
//     `AD<N>-<FASE_abrev>-<SUFIJO_TIPO>`. O SUFIJO_TIPO NÃO é o tipo plano:
//       video    -> "VID"        ex. AD13-CAP-VID
//       estático -> "EST"        ex. AD3-LEMB-EST
//       carrossel-> "EST-CARR"   ex. AD3-AQUEC-EST-CARR
//   - As filas de arquivo já finalizado usam outro formato e OUTRO contador:
//     `L<leva>-<TIPO>-AD<N>-V<versão>-<FASE_abrev>`  ex. L1-VID-AD54-V1-CAP.
//     (em captação FEV 26 os placeholders vão AD13..AD20 e os arquivos AD54..AD65
//     — contadores distintos, por isso só olhamos as filas placeholder.)
//
// A regra exata da numeração entre fases/launches ainda não está confirmada com
// o time (ver TODO-MANUEL.md / HUECOS.md §14.4). Por isso `inferNumeracao` é
// CONSERVADOR de propósito: só devolve um número se houver precedente limpio
// entre as filas placeholder da mesma fase+tipo; à mínima dúvida -> { ambiguo: true }
// e o caller pede ao usuário o número de arranque (`desde:<N>`).

export type Tipo = "VID" | "EST" | "CAR";

// Abreviação da fase no NOME placeholder (col FASE do dropdown, em minúsculas,
// -> abreviação). FASE_abrev nos arquivos finalizados costuma ser a mesma (CAP,
// AQUEC, LEMB, REGRE, ...).
const FASE_ABREV: Record<string, string> = {
  "captação": "CAP",
  "aquecimento": "AQUEC",
  "lembrete/comprometimento": "LEMB",
  "contagem regressiva": "REGRE",
  "avisos": "AVI",
  "grupo vip": "VIP",
};

export function faseAbrev(fase: string): string | null {
  return FASE_ABREV[fase.trim().toLowerCase()] ?? null;
}

// Sufixo do tipo no NOME placeholder. Atenção: carrossel -> "EST-CARR", não "CAR".
const SUFIXO_TIPO: Record<Tipo, string> = {
  VID: "VID",
  EST: "EST",
  CAR: "EST-CARR",
};

export function buildPlaceholderName(n: number, faseAbr: string, tipo: Tipo): string {
  return `AD${n}-${faseAbr}-${SUFIXO_TIPO[tipo]}`;
}

// Resultado do parsing de um NOME existente. `formato` distingue as filas
// placeholder (que contam para a numeração) das de arquivo finalizado (que não).
interface NomeParseado {
  formato: "placeholder" | "arquivo";
  faseAbr: string;
  tipo: Tipo;
  n: number;
}

// Interpreta o sufixo do NOME placeholder em um Tipo. Devolve null se não for
// um dos três conhecidos (NOME que não sabemos interpretar -> ignorado, vira dúvida).
function sufixoParaTipo(sufixo: string): Tipo | null {
  if (sufixo === "VID") return "VID";
  if (sufixo === "EST") return "EST";
  if (sufixo === "EST-CARR" || sufixo === "CARR" || sufixo === "CAR") return "CAR";
  return null;
}

// Interpreta o código de tipo do NOME de arquivo finalizado (L<leva>-<TIPO>-...).
function codigoArquivoParaTipo(codigo: string): Tipo | null {
  if (codigo === "VID") return "VID";
  if (codigo === "EST") return "EST";
  if (codigo === "CAR" || codigo === "CARR") return "CAR";
  return null;
}

// Extrai (formato, faseAbr, tipo, N) de um NOME, cobrindo os dois formatos vistos:
//   placeholder: AD<N>-<FASE>-<SUFIJO_TIPO>      ex. AD13-CAP-VID, AD6-AQUEC-EST-CARR
//   arquivo:     L<leva>-<TIPO>-AD<N>-V<v>-<FASE> ex. L1-VID-AD54-V1-CAP, L1-CAR-AD8-V1-AQUEC
// Devolve null para qualquer outra coisa (NOME que não reconhecemos).
export function parseNome(nome: string): NomeParseado | null {
  const s = nome.trim().toUpperCase();

  // arquivo finalizado: L<leva>-<TIPO>-AD<N>-V<v>-<FASE>...
  const mArq = s.match(/^L\d+-([A-Z]+)-AD(\d+)-V\d+-([A-Z]+)/);
  if (mArq) {
    const tipo = codigoArquivoParaTipo(mArq[1]!);
    if (!tipo) return null;
    return { formato: "arquivo", tipo, n: Number(mArq[2]), faseAbr: mArq[3]! };
  }

  // placeholder: AD<N>-<FASE>-<SUFIJO_TIPO>  (o sufixo pode ter um '-' interno: EST-CARR)
  const mPh = s.match(/^AD(\d+)-([A-Z]+)-(.+)$/);
  if (mPh) {
    const sufixo = mPh[3]!.trim();
    const tipo = sufixoParaTipo(sufixo);
    if (!tipo) return null;
    return { formato: "placeholder", n: Number(mPh[1]), faseAbr: mPh[2]!, tipo };
  }

  return null;
}

export type ResultadoNumeracao =
  | { ambiguo: true }
  | { ambiguo: false; desde: number; nomes: string[] };

// Infere a numeração para `cantidad` ads novos de uma dada fase+tipo, olhando
// SÓ as filas placeholder existentes dessa mesma fase+tipo (ignora as de arquivo
// finalizado, que usam outro contador). Devolve { ambiguo: true } se:
//   - a fase não é reconhecida, ou
//   - não há nenhuma fila placeholder anterior dessa fase+tipo.
// Nesse caso o caller pede ao usuário o número de arranque (`desde:<N>`).
export function inferNumeracao(
  nomesExistentes: string[],
  fase: string,
  tipo: Tipo,
  cantidad: number,
): ResultadoNumeracao {
  const faseAbr = faseAbrev(fase);
  if (!faseAbr) return { ambiguo: true };

  const numerosMesmoTipo = nomesExistentes
    .map(parseNome)
    .filter(
      (p): p is NomeParseado =>
        p !== null && p.formato === "placeholder" && p.faseAbr === faseAbr && p.tipo === tipo,
    )
    .map((p) => p.n);

  if (numerosMesmoTipo.length === 0) return { ambiguo: true };

  const desde = Math.max(...numerosMesmoTipo) + 1;
  const nomes = numeracaoSequencial(desde, cantidad, faseAbr, tipo);
  return { ambiguo: false, desde, nomes };
}

// Constrói `cantidad` NOMEs placeholder consecutivos a partir de `desde`.
// Exportado para o caso em que o usuário passa `desde:<N>` explícito (sem inferir).
export function numeracaoSequencial(
  desde: number,
  cantidad: number,
  faseAbr: string,
  tipo: Tipo,
): string[] {
  return Array.from({ length: cantidad }, (_, i) => buildPlaceholderName(desde + i, faseAbr, tipo));
}
