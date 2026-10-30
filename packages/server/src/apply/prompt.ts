import type { SpecScenario, WorkspaceMember } from "@studio/shared";

export interface TaskPromptInput {
  change: string;
  task: { id: string; text: string; section: string | null };
  /** Absolute paths of the change's planning artifacts (proposal, specs, design). */
  contextFiles: string[];
  tasksFile: string;
  members: readonly WorkspaceMember[];
  commands: readonly string[];
  /** The scenarios of the change's delta specs (add-change-verification D9). */
  scenarios?: readonly Pick<SpecScenario, "capability" | "requirement" | "name">[];
}

const list = (items: readonly string[], empty: string) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);

/** The prompt that implements one task (add-visual-apply D6). */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const { task } = input;
  const scenarios = input.scenarios ?? [];
  return [
    `# Task ${task.id} da change \`${input.change}\``,
    "",
    task.section ? `Grupo: ${task.section}` : "",
    "",
    `> ${task.id} ${task.text}`,
    "",
    "## Contexto",
    "",
    "Leia os artefatos da change antes de começar:",
    "",
    list(input.contextFiles.map((f) => `\`${f}\``), "(nenhum)"),
    "",
    `As outras tasks estão em \`${input.tasksFile}\`, só para contexto.`,
    "",
    "## Onde está o código",
    "",
    list(input.members.map((m) => `${m.name}: \`${m.path}\``), "(nenhum)"),
    "",
    "## Comandos liberados",
    "",
    "Estes rodam sem pedir permissão. Use o parâmetro `workdir` do bash para rodar um comando dentro de um membro. Qualquer outro comando é perguntado ao usuário, que pode recusar.",
    "",
    list(input.commands.map((c) => `\`${c}\``), "(nenhum)"),
    "",
    ...(scenarios.length > 0
      ? [
          "## Cenários das specs",
          "",
          "Para os cenários que esta task implementa, escreva um teste automatizado com o nome do cenário no nome do teste. Cenários que não dá para automatizar ficam para a verificação manual.",
          "",
          list(scenarios.map((s) => `${s.capability} / ${s.requirement}: "${s.name}"`), ""),
          "",
        ]
      : []),
    "## Regras",
    "",
    "- Implemente apenas esta task. Não adiante as próximas.",
    `- Não edite \`${input.tasksFile}\`: a task é marcada quando o usuário aceita o resultado.`,
    "- Quando houver um comando liberado de teste, rode os testes relevantes antes de terminar.",
    "- Termine com um resumo curto: o que mudou (arquivos) e como foi verificado.",
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}

/** The prompt for an adjustment the user asked for while reviewing a task. */
export function buildTaskAdjustPrompt(taskId: string, request: string, tasksFile: string): string {
  return [
    `# Ajuste na task ${taskId}`,
    "",
    "O usuário revisou o resultado da task e pediu:",
    "",
    `> ${request}`,
    "",
    `Faça só esse ajuste, sem editar \`${tasksFile}\`, e termine com um resumo do que mudou e de como foi verificado.`,
  ].join("\n");
}
