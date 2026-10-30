import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { sandbox } from "../testing/fixture.ts";
import { baselineFiles } from "../testing/onboarding-agent.ts";
import { parseEvidenceTable, parseRequirements, reviewRequirements } from "./evidence.ts";
import { buildBaselinePrompt, buildDiscoveryPrompt } from "./prompt.ts";

const { dir, cli } = sandbox("studio-onb-prompt-");
const adapter = new OpenSpecAdapter(cli);
const root = join(dir, "repo");
const t = { cwd: root };
const members = [
  { name: "api", path: join(dir, "repo-api") },
  { name: "web", path: join(dir, "repo-web") },
];

beforeAll(async () => {
  mkdirSync(root);
  await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
  writeFileSync(join(root, "openspec/config.yaml"), "schema: spec-driven\ncontext: |\n  Language: pt-BR\n");
  await adapter.newChange(t, "baseline-auth");
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stable = (s: string) => s.replaceAll(dir, "<DIR>");

describe("discovery prompt (8.2)", () => {
  test("asks for the JSON file across every member", () => {
    const prompt = buildDiscoveryPrompt(members, join(dir, "work/job/capabilities.json"));
    const text = stable(prompt.text);
    expect(text).toContain("Escreva apenas o arquivo `<DIR>/work/job/capabilities.json`");
    expect(text).toContain("- api: `<DIR>/repo-api`\n- web: `<DIR>/repo-web`");
    expect(text).toContain("`member` é um destes nomes: `api`, `web`.");
    expect(text).toContain("locais em mais de um membro");
    expect(prompt.system).toContain("nunca o altera");
    expect(text).toMatchSnapshot();
  });
});

describe("baseline prompt (8.5)", () => {
  test("observable behavior, tests as source, evidence table, no tasks.md", async () => {
    const instr = Object.fromEntries(
      await Promise.all(
        (["proposal", "specs", "design"] as const).map(async (a) => [a, await adapter.instructions(t, "baseline-auth", a)]),
      ),
    );
    const cap = {
      name: "auth",
      description: "Login e sessão.",
      locations: [
        { member: "api", path: "src/auth" },
        { member: "web", path: "src/login.tsx" },
      ],
    };
    const prompt = buildBaselinePrompt(cap, members, { proposal: instr.proposal!, specs: instr.specs!, design: instr.design! });
    const text = stable(prompt.text);
    expect(text).toContain("# Baseline: auth (change `baseline-auth`)");
    expect(text).toContain("Todos dentro de `<DIR>/repo/openspec/changes/baseline-auth`:");
    expect(text).toContain("- api: `src/auth` (`<DIR>/repo-api/src/auth`)");
    expect(text).toContain("começa com `## Purpose`");
    expect(text).toContain("apenas `## ADDED Requirements`");
    expect(text).toContain("comportamento observável");
    expect(text).toContain("derive os cenários deles e use `testado`");
    expect(text).toContain("sem teste correspondente é `inferido`");
    expect(text).toContain("## Evidências\n\n| Requisito | Evidência | Fonte |");
    expect(text).toContain("Não escreva `tasks.md`");
    expect(text).toContain("## Contexto do projeto (restrição, não copie)\n\nLanguage: pt-BR");
    expect(text).toMatchSnapshot();
  });
});

describe("evidence table (8.6)", () => {
  const files = baselineFiles("auth");
  test("parses rows, splitting evidence and reading the source", () => {
    expect(parseEvidenceTable(files["design.md"])).toEqual([
      { requirement: "Validar credenciais", evidence: ["api/src/auth.ts:12", "api/test/auth.test.ts:5"], source: "testado" },
      { requirement: "Registrar tentativas", evidence: ["api/src/auth.ts:40"], source: "inferido" },
    ]);
    expect(parseEvidenceTable("# Design\n\nSem tabela.\n")).toEqual([]);
  });

  test("a requirement without a row, or not tested, is inferred", () => {
    const spec = files["specs/auth/spec.md"]! + "\n### Requirement: Sem linha\nO sistema SHALL algo.\n";
    const review = reviewRequirements(spec, files["design.md"]);
    expect(review.map((r) => [r.name, r.inferred, r.evidence.length])).toEqual([
      ["Validar credenciais", false, 2],
      ["Registrar tentativas", true, 1],
      ["Sem linha", true, 0],
    ]);
  });

  test("requirement text stops at the first scenario", () => {
    expect(parseRequirements(files["specs/auth/spec.md"]!)[0]).toEqual({
      name: "Validar credenciais",
      text: "O sistema SHALL recusar credenciais inválidas em auth.",
    });
  });
});
