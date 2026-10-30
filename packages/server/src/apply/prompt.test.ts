import { describe, expect, test } from "bun:test";
import type { WorkspaceMember } from "@studio/shared";
import { buildTaskPrompt, type TaskPromptInput } from "./prompt.ts";

const input: TaskPromptInput = {
  change: "c",
  task: { id: "1.1", text: "t", section: "S" },
  contextFiles: ["/r/p.md"],
  tasksFile: "/r/tasks.md",
  members: [{ name: "api", path: "/w/api" } as WorkspaceMember],
  commands: ["bun test"],
};

/** The prompt as it was before add-change-verification, for a change without scenarios. */
const BEFORE =
  "# Task 1.1 da change `c`\n\nGrupo: S\n\n> 1.1 t\n\n## Contexto\n\nLeia os artefatos da change antes de começar:\n\n- `/r/p.md`\n\nAs outras tasks estão em `/r/tasks.md`, só para contexto.\n\n## Onde está o código\n\n- api: `/w/api`\n\n## Comandos liberados\n\nEstes rodam sem pedir permissão. Use o parâmetro `workdir` do bash para rodar um comando dentro de um membro. Qualquer outro comando é perguntado ao usuário, que pode recusar.\n\n- `bun test`\n\n## Regras\n\n- Implemente apenas esta task. Não adiante as próximas.\n- Não edite `/r/tasks.md`: a task é marcada quando o usuário aceita o resultado.\n- Quando houver um comando liberado de teste, rode os testes relevantes antes de terminar.\n- Termine com um resumo curto: o que mudou (arquivos) e como foi verificado.";

describe("1.2 cenários das specs no apply", () => {
  test("Cenários no pedido da task: the change's scenarios are listed, with tests named after them", () => {
    const text = buildTaskPrompt({
      ...input,
      scenarios: [
        { capability: "git-repositories", requirement: "Inicializar Git", name: "Pré-visualização" },
        { capability: "git-repositories", requirement: "Inicializar Git", name: "Confirmar" },
      ],
    });
    expect(text).toContain("## Cenários das specs");
    expect(text).toContain('- git-repositories / Inicializar Git: "Pré-visualização"\n- git-repositories / Inicializar Git: "Confirmar"');
    expect(text).toContain("com o nome do cenário no nome do teste");
    expect(text.indexOf("## Cenários das specs")).toBeLessThan(text.indexOf("## Regras"));
  });

  test("Change sem cenários: the prompt is the same as before", () => {
    expect(buildTaskPrompt(input)).toBe(BEFORE);
    expect(buildTaskPrompt({ ...input, scenarios: [] })).toBe(BEFORE);
  });
});
