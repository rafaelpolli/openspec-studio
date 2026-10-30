import { answerText, type DecisionCheckpoint, type ProposalArtifact } from "@studio/shared";

/** The file in the change folder; not a schema artifact, archived with the change (D6). */
export const DECISIONS_MD = "decisions.md";

const STATUS: Record<DecisionCheckpoint["status"], string> = {
  levantando: "levantando as decisões",
  aguardando: "aguardando as respostas",
  respondido: "respondido",
  pulado: "pulado pelo usuário",
  falhou: "falhou",
};

const ORIGIN = { recomendada: "recomendada", opcao: "outra opção", propria: "resposta própria" } as const;

/**
 * `decisions.md` (D6): the checkpoint's decisions with each answer and where it came from,
 * and the assumptions accepted with each approved artifact. Rewritten from the database.
 */
export function renderDecisions(change: string, checkpoint: DecisionCheckpoint, artifacts: readonly ProposalArtifact[]): string {
  const lines = [`# Decisões: ${change}`, "", `- Checkpoint: ${checkpoint.status === "respondido" && checkpoint.decisions.length === 0 ? "sem decisões a tomar" : STATUS[checkpoint.status]}`, ""];
  if (checkpoint.decisions.length > 0) {
    lines.push("## Decisões", "");
    for (const d of checkpoint.decisions) {
      const answer = checkpoint.answers.find((a) => a.id === d.id);
      lines.push(`### ${d.question}`, "");
      if (d.why) lines.push(d.why, "");
      lines.push(`- Opções: ${d.options.map((o, i) => (i === d.recommended ? `${o.label} (recomendada)` : o.label)).join("; ")}`);
      const text = answerText(d, answer);
      // An answer from the exploration that the user kept; once edited, it is the user's.
      const origin = d.source === "exploracao" && answer?.kind === "recomendada" ? "da exploração" : answer ? ORIGIN[answer.kind] : "";
      lines.push(`- Resposta: ${text && answer ? `${text} (${origin})` : checkpoint.status === "pulado" ? "não respondida (checkpoint pulado)" : "sem resposta"}`, "");
    }
  }
  const accepted = artifacts.filter((a) => a.state === "aprovado" && (a.assumptions?.length ?? 0) > 0);
  if (accepted.length > 0) {
    lines.push("## Suposições aceitas", "");
    for (const a of accepted) {
      lines.push(`### ${a.id}`, "");
      for (const s of a.assumptions!) lines.push(`- ${s.text}${s.question ? ` (pergunta do agente: ${s.question})` : ""}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
