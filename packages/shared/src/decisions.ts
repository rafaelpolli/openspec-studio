import { z } from "zod";

// Decisions checkpoint of the guided proposal and the agent's assumptions (add-proposal-decisions).

export interface DecisionOption {
  label: string;
  description?: string;
}

/** An open decision the agent raised before the proposal, with its options and a recommendation. */
export interface Decision {
  id: string;
  question: string;
  /** Why it matters, in one line. */
  why?: string;
  options: DecisionOption[];
  /** Index of the recommended option. */
  recommended: number;
  /** Came already answered from the exploration the change was created from (add-workspace-explore). */
  source?: "exploracao";
}

/** How the user answered: the recommendation, another option, or in their own words. */
export const DecisionAnswer = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("recomendada") }),
  z.object({ id: z.string(), kind: z.literal("opcao"), option: z.number().int().min(0) }),
  z.object({ id: z.string(), kind: z.literal("propria"), text: z.string().trim().min(1) }),
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

export const AnswersInput = z.object({ answers: z.array(DecisionAnswer) });

export type DecisionStatus = "levantando" | "aguardando" | "respondido" | "pulado" | "falhou";

/** The change's decisions checkpoint; null in the view for a change without one. */
export interface DecisionCheckpoint {
  status: DecisionStatus;
  decisions: Decision[];
  answers: DecisionAnswer[];
  error?: string;
  /** "Gerar o restante" waits for the answers and continues after them. */
  resumeAuto: boolean;
}

/** Something the agent decided on its own while writing an artifact. */
export interface Assumption {
  text: string;
  /** The question the agent asked, when the assumption came from one nobody could answer. */
  question?: string;
}

/** The text of an answer, as it goes into prompts and decisions.md. */
export function answerText(decision: Decision, answer: DecisionAnswer | undefined): string | undefined {
  if (!answer) return undefined;
  if (answer.kind === "propria") return answer.text;
  const index = answer.kind === "recomendada" ? decision.recommended : answer.option;
  return decision.options[index]?.label;
}
