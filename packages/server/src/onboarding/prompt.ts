import type { ArtifactInstructions, CapabilityDraft, WorkspaceMember } from "@studio/shared";
import type { BuiltPrompt } from "../proposal/prompt.ts";
import { EVIDENCE_HEADING } from "./evidence.ts";

const SYSTEM = [
  "Você é o agente de onboarding de uma aplicação que aplica o OpenSpec a projetos existentes.",
  "Você lê o código, mas nunca o altera.",
  "Escreva apenas os arquivos pedidos, exatamente nos caminhos indicados.",
].join("\n");

function section(title: string, body: string | undefined): string {
  return body && body.trim() ? `## ${title}\n\n${body.trim()}\n` : "";
}

const memberList = (members: readonly WorkspaceMember[]) => members.map((m) => `- ${m.name}: \`${m.path}\``).join("\n");

/** Asks the agent to list candidate capabilities across every member (design D9, "Descoberta"). */
export function buildDiscoveryPrompt(members: readonly WorkspaceMember[], outputFile: string): BuiltPrompt {
  const names = members.map((m) => `\`${m.name}\``).join(", ");
  const text = [
    "# Descoberta de capacidades\n",
    "Leia o código dos membros abaixo e liste as capacidades do sistema: comportamentos que um usuário ou " +
      "outro sistema observa (por exemplo, autenticação ou exportação de relatórios), e não camadas técnicas " +
      "(por exemplo, banco de dados ou utilitários).\n",
    section("Membros (somente leitura)", memberList(members)),
    section(
      "Saída",
      `Escreva apenas o arquivo \`${outputFile}\`, com este JSON:\n\n` +
        "```json\n" +
        '{ "capabilities": [ { "name": "auth", "description": "Uma frase sobre o que a capacidade faz.", ' +
        '"locations": [ { "member": "<nome do membro>", "path": "<caminho relativo ao membro>" } ] } ] }\n' +
        "```",
    ),
    section(
      "Regras",
      [
        "- `name` em kebab-case (letras minúsculas, dígitos e hífen), sem repetir.",
        `- \`member\` é um destes nomes: ${names}.`,
        "- `path` aponta para um arquivo ou pasta onde a capacidade está implementada; uma capacidade pode ter locais em mais de um membro.",
        "- Prefira capacidades coesas, de 3 a 15 no total, cada uma documentável numa spec própria.",
        "- Não escreva nenhum outro arquivo.",
      ].join("\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n");
  return { system: SYSTEM, text };
}

export interface BaselineInstructions {
  proposal: ArtifactInstructions;
  specs: ArtifactInstructions;
  design: ArtifactInstructions;
}

function artifactGuide(instr: ArtifactInstructions): string {
  return [
    `### ${instr.artifactId}\n`,
    instr.instruction.trim(),
    instr.template ? "\nTemplate:\n\n```markdown\n" + instr.template.trim() + "\n```" : "",
  ].join("\n");
}

/**
 * Asks the agent to document how one capability behaves today, as a change with only
 * ADDED requirements and an evidence table in design.md (design D9; spec:
 * project-onboarding, "Qualidade da spec de baseline"). No tasks.md: spike 1.4 showed
 * `archive` accepts a change without one.
 */
export function buildBaselinePrompt(
  cap: CapabilityDraft,
  members: readonly WorkspaceMember[],
  instr: BaselineInstructions,
): BuiltPrompt {
  const dir = instr.specs.changeDir;
  const byName = new Map(members.map((m) => [m.name, m.path]));
  const locations = cap.locations
    .map((l) => `- ${l.member}: \`${l.path}\`${byName.has(l.member) ? ` (\`${byName.get(l.member)}/${l.path}\`)` : ""}`)
    .join("\n");
  const table = [
    EVIDENCE_HEADING,
    "",
    "| Requisito | Evidência | Fonte |",
    "|---|---|---|",
    "| <nome exato do requisito> | `<membro>/<arquivo>:<linha>`, `<membro>/<arquivo>:<linha>` | testado ou inferido |",
  ].join("\n");
  const text = [
    `# Baseline: ${cap.name} (change \`${instr.specs.changeName}\`)\n`,
    "Documente o comportamento que já existe nesta capacidade. É uma baseline: não proponha mudanças nem novas funcionalidades.\n",
    section("Capacidade", `${cap.description}\n\nLocais apontados na descoberta:\n\n${locations || "- (nenhum)"}`),
    section(
      "Arquivos a escrever",
      [
        `Todos dentro de \`${dir}\`:`,
        "",
        "1. `proposal.md`: por que documentar esta capacidade agora e o que a spec cobre.",
        `2. \`specs/${cap.name}/spec.md\`: começa com \`## Purpose\` (uma ou duas frases sobre o que a capacidade faz) e depois apenas \`## ADDED Requirements\`, cada requisito com pelo menos um cenário.`,
        "3. `design.md`: como a capacidade funciona hoje, terminando com a seção abaixo, exatamente neste formato:",
        "",
        "```markdown\n" + table + "\n```",
        "",
        "Não escreva `tasks.md`: a baseline não altera código.",
      ].join("\n"),
    ),
    section(
      "Qualidade",
      [
        "- Descreva comportamento observável (entradas, saídas, erros e efeitos visíveis), não a implementação (nomes de classes, funções ou bibliotecas).",
        "- Quando houver testes, derive os cenários deles e use `testado`, citando o `arquivo:linha` do teste.",
        "- Um requisito sem teste correspondente é `inferido`, citando o `arquivo:linha` do código que o sustenta.",
        "- Cada linha da tabela usa o nome exato de um `### Requirement:` da spec, e cada requisito tem uma linha.",
        "- Os caminhos das evidências começam pelo nome do membro, por exemplo `api/src/auth.ts:42`.",
      ].join("\n"),
    ),
    section("Código que você pode ler (somente leitura)", memberList(members)),
    section(
      "Instruções do OpenSpec",
      [instr.proposal, instr.specs, instr.design].map(artifactGuide).join("\n\n"),
    ),
    section("Contexto do projeto (restrição, não copie)", instr.specs.context),
  ]
    .filter(Boolean)
    .join("\n");
  return { system: SYSTEM, text };
}
