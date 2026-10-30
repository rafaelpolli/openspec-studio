import type { Assumption, Decision } from "@studio/shared";
import { z } from "zod";

/** Folder in the change where the agent writes its structured output; removed after each run (D2). */
export const WORK_DIR = ".studio";
export const DECISIONS_FILE = "decisoes.json";
export const assumptionsFile = (artifactId: string) => `suposicoes-${artifactId}.json`;
const MAX_DECISIONS = 8;

/** Thrown when the agent's JSON is missing or is not the one asked for. */
export class AgentOutputError extends Error {
  override readonly name = "AgentOutputError";
}

const DecisionsFile = z.object({
  decisions: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        question: z.string().trim().min(1),
        why: z.string().trim().optional(),
        options: z.array(z.object({ label: z.string().trim().min(1), description: z.string().trim().optional() })).min(2),
        recommended: z.number().int().min(0),
      }),
    )
    .max(MAX_DECISIONS),
});

/** The checkpoint's decisions (D2): at most 8, unique ids, the recommendation among the options. */
export function parseDecisions(raw: string | undefined): Decision[] {
  if (raw === undefined) throw new AgentOutputError("o agente terminou sem escrever a lista de decisões");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AgentOutputError("o agente escreveu uma lista de decisões que não é JSON");
  }
  const checked = DecisionsFile.safeParse(json);
  if (!checked.success) throw new AgentOutputError("a lista de decisões do agente não segue o formato pedido");
  const ids = new Set<string>();
  for (const d of checked.data.decisions) {
    if (ids.has(d.id)) throw new AgentOutputError(`decisão repetida: ${d.id}`);
    ids.add(d.id);
    if (d.recommended >= d.options.length) throw new AgentOutputError(`a recomendação de ${d.id} não é uma das opções`);
  }
  return checked.data.decisions.map((d) => ({
    id: d.id,
    question: d.question,
    ...(d.why ? { why: d.why } : {}),
    options: d.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    recommended: d.recommended,
  }));
}

const AssumptionsFile = z.object({
  assumptions: z.array(z.object({ text: z.string().trim().min(1), question: z.string().trim().optional() })),
});

/** The agent's assumptions for one artifact; a missing or unusable file is an empty list (D2). */
export function parseAssumptions(raw: string | undefined): Assumption[] {
  if (raw === undefined) return [];
  try {
    const checked = AssumptionsFile.safeParse(JSON.parse(raw));
    if (!checked.success) return [];
    return checked.data.assumptions.map((a) => ({ text: a.text, ...(a.question ? { question: a.question } : {}) }));
  } catch {
    return [];
  }
}
