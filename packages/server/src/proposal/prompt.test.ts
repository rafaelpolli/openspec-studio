import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { sandbox } from "../testing/fixture.ts";
import { buildAdjustPrompt, buildArtifactPrompt, buildFixPrompt } from "./prompt.ts";

const { dir, cli } = sandbox("studio-prompt-");
const adapter = new OpenSpecAdapter(cli);
const root = join(dir, "repo");
const t = { cwd: root };
const members = [{ name: "repo", path: root }];

beforeAll(async () => {
  mkdirSync(root);
  await cli.run(["init", "--tools", "none", "--language", "pt-BR", "--no-animation"], { cwd: root });
  writeFileSync(join(root, "openspec/config.yaml"), `${"schema: spec-driven\ncontext: |\n  Stack: Bun.\nrules:\n  proposal:\n    - Seja breve\n"}`);
  await adapter.newChange(t, "add-export");
  writeFileSync(join(root, "openspec/changes/add-export/proposal.md"), "# Proposal\n");
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Replaces the temp folder so snapshots are stable. */
const stable = (s: string) => s.replaceAll(root, "<ROOT>");

describe("prompt builder (7.2)", () => {
  test("artifact prompt carries instruction, template, constraints, dependencies and output path", async () => {
    const instr = await adapter.instructions(t, "add-export", "design");
    const prompt = buildArtifactPrompt(instr, { description: "Exportar dados em CSV", members });
    const text = stable(prompt.text);
    expect(text).toContain("# Artefato: design (change `add-export`, schema `spec-driven`)");
    expect(text).toContain("## Descrição da change pelo usuário\n\nExportar dados em CSV");
    expect(text).toContain("Escreva o arquivo `<ROOT>/openspec/changes/add-export/design.md`.");
    expect(text).toContain(instr.instruction.trim().slice(0, 60));
    expect(text).toContain("```markdown\n# Design");
    expect(text).toContain("## Contexto do projeto (restrição, não copie)\n\nStack: Bun.");
    expect(text).toContain("- proposal: `<ROOT>/openspec/changes/add-export/proposal.md`");
    expect(text).toContain("## Código que você pode ler (somente leitura)\n\n- repo: `<ROOT>`");
    expect(text).not.toContain("Regras deste artefato"); // design has no rules
    expect(text).toMatchSnapshot();
    expect(prompt.system).toMatchSnapshot();
  });

  test("glob artifacts ask for concrete paths matching the pattern; rules are included", async () => {
    const specs = buildArtifactPrompt(await adapter.instructions(t, "add-export", "specs"), { description: "x", members });
    expect(stable(specs.text)).toContain("casem com o padrão `specs/**/*.md`");
    const proposal = buildArtifactPrompt(await adapter.instructions(t, "add-export", "proposal"), { description: "x", members });
    expect(proposal.text).toContain("## Regras deste artefato (restrição, não copie)\n\n- Seja breve");
  });

  test("adjust and fix prompts name the files and the request or issues", () => {
    const adjust = buildAdjustPrompt("proposal", ["/r/proposal.md"], "remova a parte de autenticação do escopo");
    expect(adjust.text).toMatchSnapshot();
    const fix = buildFixPrompt("specs", ["/r/specs/export/spec.md"], [
      { level: "ERROR", path: "export/spec.md", message: 'ADDED "X" must include at least one scenario' },
    ]);
    expect(fix.text).toContain('- [ERROR] export/spec.md: ADDED "X" must include at least one scenario');
  });
});

describe("3.1 decisões e suposições nos prompts (add-proposal-decisions)", () => {
  const ctx = {
    decisions: [
      { question: "Quais campos entram no CSV?", answer: "só nome e e-mail" },
      { question: "Formato da data?", answer: "ISO 8601" },
    ],
    assumptionsFile: "<ROOT>/openspec/changes/add-export/.studio/suposicoes-design.json",
  };

  test("Resposta seguida: the artifact prompt carries the answered decisions and asks for the assumptions apart", async () => {
    const instr = await adapter.instructions(t, "add-export", "design");
    const text = stable(buildArtifactPrompt(instr, { description: "Exportar dados em CSV", members, ...ctx }).text);
    const decisions = text.slice(text.indexOf("## Decisões do usuário (siga)"));
    expect(decisions).toMatchSnapshot();
    expect(text.indexOf("## Decisões do usuário (siga)")).toBeGreaterThan(text.indexOf("## Código que você pode ler"));
  });

  test("skipped or without a checkpoint: no decisions section, only the request for assumptions", async () => {
    const instr = await adapter.instructions(t, "add-export", "design");
    const without = stable(buildArtifactPrompt(instr, { description: "x", members }).text);
    const skipped = stable(buildArtifactPrompt(instr, { description: "x", members, assumptionsFile: ctx.assumptionsFile }).text);
    expect(skipped).not.toContain("Decisões do usuário");
    expect(skipped.startsWith(without.trimEnd())).toBe(true);
    expect(skipped.slice(without.trimEnd().length)).toContain("## Suposições\n\nListe em `<ROOT>/openspec/changes/add-export/.studio/suposicoes-design.json`");
  });

  test("the adjust prompt carries them too; without them it is the same as before", () => {
    const before = buildAdjustPrompt("proposal", ["/r/proposal.md"], "x").text;
    const withCtx = buildAdjustPrompt("proposal", ["/r/proposal.md"], "x", ctx).text;
    expect(withCtx.startsWith(before)).toBe(true);
    expect(withCtx).toContain("- Formato da data? → ISO 8601");
    expect(withCtx).toContain("Não escreva essa lista no artefato.");
  });
});
