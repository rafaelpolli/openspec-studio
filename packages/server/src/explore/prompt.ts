import type { WorkspaceMember } from "@studio/shared";
import type { BuiltPrompt } from "../proposal/prompt.ts";

/** The agent's stance in an exploration, like `/opsx:explore` (add-workspace-explore D3). */
const SYSTEM = [
  "Você é o parceiro de exploração de uma aplicação que aplica o OpenSpec. O usuário ainda não decidiu o que construir.",
  "Pense junto: faça perguntas, mostre opções com prós e contras, recomende quando houver base no código, use diagramas em ASCII quando ajudarem.",
  "Leia o código, as specs e as changes para fundamentar o que diz. Nunca implemente nada e não escreva arquivos do workspace.",
  "Escreva só os arquivos que um pedido indicar, exatamente nos caminhos indicados.",
].join("\n");

export interface WorkspaceContext {
  specs: readonly { id: string; purpose: string }[];
  /** Names of the active changes. */
  changes: readonly string[];
}

const list = (items: readonly string[], empty: string) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);

/** The first message of an exploration: the workspace, its specs and changes, and the title file (D3, D6). */
export function buildFirstPrompt(input: {
  message: string;
  members: readonly WorkspaceMember[];
  context: WorkspaceContext;
  titleFile: string;
  /** What the exploration it continues from left: a summary, or its last messages. */
  previous?: string;
}): BuiltPrompt {
  const text = [
    "# Exploração",
    "",
    "## Código que você pode ler (somente leitura)",
    "",
    list(input.members.map((m) => `${m.name}: \`${m.path}\``), "(nenhum)"),
    "",
    "## Specs do workspace",
    "",
    list(input.context.specs.map((s) => `\`${s.id}\`: ${s.purpose.trim().split("\n")[0]}`), "(nenhuma)"),
    "",
    "## Changes ativas",
    "",
    list(input.context.changes.map((c) => `\`${c}\``), "(nenhuma)"),
    "",
    ...(input.previous ? ["## Exploração anterior", "", input.previous.trim(), ""] : []),
    "## Título",
    "",
    `Depois de responder, escreva em \`${input.titleFile}\` um título curto (até 6 palavras) para esta exploração, só o texto.`,
    "",
    "## Mensagem do usuário",
    "",
    input.message,
  ].join("\n");
  return { system: SYSTEM, text };
}

/** Every later message: the session already has the conversation. */
export function buildNextPrompt(message: string): BuiltPrompt {
  return { system: SYSTEM, text: message };
}

/** Asks for the "Virar change" draft (D4): name, description and the decisions taken. */
export function buildDraftPrompt(outputFile: string): BuiltPrompt {
  return {
    system: SYSTEM,
    text: [
      "# Virar change",
      "",
      "O usuário quer transformar esta exploração numa change do OpenSpec. Não responda na conversa: " +
        `escreva apenas o arquivo \`${outputFile}\`, com este JSON:`,
      "",
      "```json",
      '{ "name": "add-exemplo", "description": "um a três parágrafos: o que construir e por quê", ' +
        '"decisions": [ { "question": "a decisão, em poucas palavras", "answer": "o que ficou decidido" } ] }',
      "```",
      "",
      "- `name` em kebab-case, começando por um verbo como add, fix ou update.",
      "- `decisions` só com o que o usuário decidiu ou confirmou na conversa; nada que você apenas sugeriu.",
      "- Não escreva nenhum outro arquivo.",
    ].join("\n"),
  };
}

/** What "Continuar a partir de…" carries from the previous exploration (D6). */
export function previousContext(input: {
  title: string | null;
  change?: string;
  summary?: string;
  messages: readonly { role: "usuario" | "agente"; text: string }[];
}): string {
  const head = `"${input.title ?? "sem título"}"${input.change ? `, que virou a change \`${input.change}\`` : ", descartada"}.`;
  if (input.summary) return `${head}\n\n${input.summary}`;
  const last = input.messages.slice(-20).map((m) => `**${m.role === "usuario" ? "Usuário" : "Agente"}:** ${m.text.slice(0, 2000)}`);
  return [head, "", "Últimas mensagens:", "", ...last].join("\n\n").replace(/\n{3,}/g, "\n\n");
}
