import { describe, expect, test } from "bun:test";
import { buildDraftPrompt, buildFirstPrompt, buildNextPrompt, previousContext } from "./prompt.ts";

const context = {
  specs: [
    { id: "change-apply", purpose: "Executar as tasks de uma change.\nSegunda linha." },
    { id: "workspaces", purpose: "Registrar pastas." },
  ],
  changes: ["add-x"],
};

describe("2.1 prompts da exploração", () => {
  test("Contexto do workspace: the first prompt lists the code, the specs with their purpose, the changes and the title file", () => {
    const { system, text } = buildFirstPrompt({
      message: "o que do BMAD eu poderia incluir?",
      members: [{ name: "app", path: "/w/app" }],
      context,
      titleFile: "/data/explore/w/e1/titulo.txt",
    });
    expect(system).toContain("Nunca implemente nada");
    expect(text).toMatchSnapshot();
    expect(text).not.toContain("Segunda linha");
    expect(text).not.toContain("Exploração anterior");
  });

  test("a continued exploration carries the previous one; later messages go as they are", () => {
    const { text } = buildFirstPrompt({ message: "m", members: [], context: { specs: [], changes: [] }, titleFile: "/t", previous: "resumo anterior" });
    expect(text).toContain("## Exploração anterior\n\nresumo anterior\n\n## Título");
    expect(text).toContain("## Specs do workspace\n\n- (nenhuma)");
    expect(buildNextPrompt("detalhe a opção B").text).toBe("detalhe a opção B");
  });

  test("the draft prompt asks for the JSON only, with decisions the user took", () => {
    expect(buildDraftPrompt("/data/explore/w/e1/rascunho.json").text).toMatchSnapshot();
  });

  test("previousContext: the summary when it became a change, otherwise the last 20 messages, each cut at 2000 characters", () => {
    expect(previousContext({ title: "BMAD", change: "add-v", summary: "Resumo.\n\n- Decisão: x", messages: [] })).toBe(
      '"BMAD", que virou a change `add-v`.\n\nResumo.\n\n- Decisão: x',
    );
    const messages = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? ("agente" as const) : ("usuario" as const), text: `m${i}${i === 24 ? "x".repeat(3000) : ""}` }));
    const text = previousContext({ title: null, messages });
    expect(text).toStartWith('"sem título", descartada.');
    expect(text).not.toContain("**Agente:** m3\n");
    expect(text).toContain("**Agente:** m5");
    expect(text.length).toBeLessThan(2200 + 20 * 40);
  });
});
