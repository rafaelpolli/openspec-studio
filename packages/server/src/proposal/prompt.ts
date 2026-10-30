import type { ArtifactInstructions, ValidationIssue } from "@studio/shared";

export interface PromptContext {
  /** The user's description of the change. */
  description: string;
  /** Code folders the agent may read (workspace members). */
  members: readonly { name: string; path: string }[];
}

/** What the artifact prompts carry from the decisions checkpoint (add-proposal-decisions D5). */
export interface DecisionContext {
  /** The answered decisions, as question and answer. */
  decisions?: readonly { question: string; answer: string }[];
  /** Where the agent lists what it decided on its own. */
  assumptionsFile?: string;
}

function decisionSections(ctx: DecisionContext): string[] {
  return [
    section(
      "Decisões do usuário (siga)",
      ctx.decisions?.length ? ctx.decisions.map((d) => `- ${d.question} → ${d.answer}`).join("\n") : undefined,
    ),
    section(
      "Suposições",
      ctx.assumptionsFile
        ? `Liste em \`${ctx.assumptionsFile}\` cada decisão que você tomou sozinho e que muda escopo ou comportamento, ` +
            'com este JSON: `{ "assumptions": [ { "text": "...", "question": "<a pergunta, se você fez uma>" } ] }`. ' +
            "Use `[]` quando não houver nenhuma. Não escreva essa lista no artefato."
        : undefined,
    ),
  ];
}

export interface BuiltPrompt {
  system: string;
  text: string;
}

const SYSTEM = [
  "Você é o agente de planejamento de uma aplicação que aplica o OpenSpec.",
  "Escreva apenas os arquivos de artefato pedidos, exatamente nos caminhos indicados.",
  "Não altere código-fonte nem arquivos fora da pasta da change.",
  "Siga o template e a instrução do OpenSpec; trate contexto e regras do projeto como restrições, sem copiá-los para o arquivo.",
].join("\n");

function section(title: string, body: string | undefined): string {
  return body && body.trim() ? `## ${title}\n\n${body.trim()}\n` : "";
}

/** Prompt that asks the agent to write one artifact (design D5). */
export function buildArtifactPrompt(instr: ArtifactInstructions, ctx: PromptContext & DecisionContext): BuiltPrompt {
  const glob = instr.outputPath.includes("*");
  const output = glob
    ? `Escreva um ou mais arquivos que casem com o padrão \`${instr.outputPath}\`, dentro de \`${instr.changeDir}\`. ` +
      `O caminho completo resolvido é \`${instr.resolvedOutputPath}\`; escolha caminhos concretos conforme a instrução.`
    : `Escreva o arquivo \`${instr.resolvedOutputPath}\`.`;
  const deps = instr.dependencies
    .filter((d) => d.done)
    .map((d) => `- ${d.id}: \`${instr.changeDir}/${d.path}\``)
    .join("\n");
  const members = ctx.members.map((m) => `- ${m.name}: \`${m.path}\``).join("\n");
  const text = [
    `# Artefato: ${instr.artifactId} (change \`${instr.changeName}\`, schema \`${instr.schemaName}\`)\n`,
    section("Descrição da change pelo usuário", ctx.description),
    section("Saída", output),
    section("Instrução do OpenSpec", instr.instruction),
    section("Template", instr.template ? "```markdown\n" + instr.template.trim() + "\n```" : undefined),
    section("Contexto do projeto (restrição, não copie)", instr.context),
    section("Regras deste artefato (restrição, não copie)", instr.rules?.map((r) => `- ${r}`).join("\n")),
    section("Artefatos concluídos para ler antes", deps),
    section("Código que você pode ler (somente leitura)", members),
    ...decisionSections(ctx),
  ]
    .filter(Boolean)
    .join("\n");
  return { system: SYSTEM, text };
}

/** Asks the agent to rewrite an artifact following the user's request. */
export function buildAdjustPrompt(
  artifactId: string,
  files: readonly string[],
  request: string,
  ctx: DecisionContext = {},
): BuiltPrompt {
  return {
    system: SYSTEM,
    text: [
      `# Ajuste no artefato ${artifactId}\n`,
      section("Pedido do usuário", request),
      section("Arquivos a reescrever", files.map((f) => `- \`${f}\``).join("\n")),
      "Leia os arquivos atuais, aplique o pedido e mantenha o formato do OpenSpec.\n",
      ...decisionSections(ctx),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Asks the agent to fix OpenSpec validation issues in an artifact. */
export function buildFixPrompt(
  artifactId: string,
  files: readonly string[],
  issues: readonly ValidationIssue[],
): BuiltPrompt {
  const list = issues.map((i) => `- [${i.level}]${i.path ? ` ${i.path}:` : ""} ${i.message}`).join("\n");
  return {
    system: SYSTEM,
    text: [
      `# Corrigir validação do artefato ${artifactId}\n`,
      section("Problemas encontrados pelo `openspec validate`", list),
      section("Arquivos", files.map((f) => `- \`${f}\``).join("\n")),
      "Corrija os arquivos para que a validação passe, sem mudar o conteúdo além do necessário.\n",
    ].join("\n"),
  };
}

/**
 * Asks the agent for the change's open decisions before anything is written (add-proposal-decisions
 * D1): read only, and write just the JSON file.
 */
export function buildDecisionsPrompt(
  ctx: PromptContext & { change: string; outputFile: string; taken?: readonly { question: string; answer: string }[] },
): BuiltPrompt {
  const members = ctx.members.map((m) => `- ${m.name}: \`${m.path}\``).join("\n");
  return {
    system: SYSTEM,
    text: [
      `# Decisões em aberto da change \`${ctx.change}\`\n`,
      "Antes de escrever qualquer artefato, leia a descrição e o código e liste as decisões que só o usuário pode tomar: " +
        "escopo, comportamento visível, compatibilidade e critérios de aceite. Não liste detalhes de implementação que você mesmo pode decidir.\n",
      section("Descrição da change pelo usuário", ctx.description),
      section("Código que você pode ler (somente leitura)", members),
      section(
        "Decisões já tomadas na exploração (não repita)",
        ctx.taken?.length ? ctx.taken.map((t) => `- ${t.question} → ${t.answer}`).join("\n") : undefined,
      ),
      section(
        "Saída",
        `Escreva apenas o arquivo \`${ctx.outputFile}\`, com este JSON:\n\n` +
          "```json\n" +
          '{ "decisions": [ { "id": "campos", "question": "Quais campos entram no CSV?", "why": "uma linha sobre por que importa", ' +
          '"options": [ { "label": "Todos os campos do perfil" }, { "label": "Só nome e e-mail", "description": "opcional" } ], "recommended": 1 } ] }\n' +
          "```",
      ),
      section(
        "Regras",
        [
          "- De 0 a 8 decisões; `{ \"decisions\": [] }` quando não há nada a decidir.",
          "- Cada decisão tem pelo menos duas opções, e `recommended` é o índice (a partir de 0) da opção que você recomenda.",
          "- `id` em kebab-case, sem repetir.",
          "- Não escreva nenhum artefato nem outro arquivo nesta etapa.",
        ].join("\n"),
      ),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
