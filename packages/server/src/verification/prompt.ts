import type { SpecScenario, TestEvidence, TraceKind, WorkspaceMember } from "@studio/shared";
import { z } from "zod";
import type { BuiltPrompt } from "../proposal/prompt.ts";

const SYSTEM = [
  "Você é o agente de verificação de uma aplicação que implementa changes do OpenSpec.",
  "Você lê o código e as specs, mas nunca altera nada nem roda comandos.",
  "Escreva apenas o arquivo pedido, exatamente no caminho indicado.",
].join("\n");

/**
 * Asks the agent to point, for each scenario, to the test that exercises it (D2). The list
 * of scenarios comes from the backend (D1): the agent answers by id.
 */
export function buildVerificationPrompt(input: {
  change: string;
  changeDir: string;
  members: readonly WorkspaceMember[];
  scenarios: readonly SpecScenario[];
  outputFile: string;
}): BuiltPrompt {
  const names = input.members.map((m) => `\`${m.name}\``).join(", ");
  const scenarios = input.scenarios.map((s) => [`### \`${s.id}\``, "", s.text].join("\n")).join("\n\n");
  const text = [
    `# Verificação da change \`${input.change}\``,
    "",
    `Os artefatos da change estão em \`${input.changeDir}\`. Para cada cenário abaixo, encontre no código dos membros o teste automatizado que exercita exatamente o comportamento descrito.`,
    "",
    "## Membros (somente leitura)",
    "",
    input.members.map((m) => `- ${m.name}: \`${m.path}\``).join("\n"),
    "",
    "## Cenários",
    "",
    scenarios,
    "",
    "## Saída",
    "",
    `Escreva apenas o arquivo \`${input.outputFile}\`, com este JSON:`,
    "",
    "```json",
    '{ "items": [ { "id": "<id do cenário>", "kind": "teste", "member": "<nome do membro>", "file": "<caminho relativo ao membro>", "line": 41, "name": "<nome do teste>", "note": "<opcional>" } ] }',
    "```",
    "",
    "## Regras",
    "",
    "- Um item por cenário, com o `id` exatamente como acima.",
    '- `kind` é "teste" quando há um teste que exercita o cenário, "manual" quando o cenário não dá para automatizar (por exemplo, algo visual), e "sem-teste" quando dá para automatizar mas nenhum teste o exercita.',
    `- Para "teste": \`member\` é um destes nomes: ${names}; \`line\` é a linha onde o teste é declarado; \`name\` é o nome do teste copiado do código, sem os nomes dos \`describe\`.`,
    '- Não aponte um teste só porque o arquivo trata do mesmo assunto: na dúvida, use "sem-teste" e explique em `note`.',
    "- Não escreva nenhum outro arquivo.",
  ].join("\n");
  return { system: SYSTEM, text };
}

const TraceItem = z.object({
  id: z.string(),
  kind: z.enum(["teste", "manual", "sem-teste"]),
  member: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  name: z.string().optional(),
  note: z.string().optional(),
});
const TraceFile = z.object({ items: z.array(TraceItem) });

export interface TraceEntry {
  trace: TraceKind;
  /** Present for "teste" when the agent gave every field. */
  evidence?: TestEvidence;
  note?: string;
}

/** Thrown when trace.json is not the JSON asked for. */
export class TraceError extends Error {
  override readonly name = "TraceError";
}

/**
 * The agent's answer by scenario id (D2): unknown ids are dropped, the first answer of an id
 * wins, and a scenario without an answer is "sem-teste".
 */
export function parseTrace(raw: string, scenarios: readonly SpecScenario[]): Map<string, TraceEntry> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new TraceError("o agente escreveu um trace.json que não é JSON");
  }
  const checked = TraceFile.safeParse(json);
  if (!checked.success) throw new TraceError("o trace.json do agente não segue o formato pedido");
  const known = new Set(scenarios.map((s) => s.id));
  const out = new Map<string, TraceEntry>();
  for (const item of checked.data.items) {
    if (!known.has(item.id) || out.has(item.id)) continue;
    const note = item.note?.trim() ? { note: item.note.trim() } : {};
    const { member, file, line, name } = item;
    const evidence = item.kind === "teste" && member && file && line !== undefined && name ? { evidence: { member, file, line, name } } : {};
    out.set(item.id, { trace: item.kind, ...evidence, ...note });
  }
  for (const s of scenarios) if (!out.has(s.id)) out.set(s.id, { trace: "sem-teste" });
  return out;
}
