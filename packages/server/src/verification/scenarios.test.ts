import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeScenarios, parseScenarios } from "./scenarios.ts";

const dir = mkdtempSync(join(tmpdir(), "studio-scenarios-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const requirement = (name: string, scenarios: string[]) =>
  [`### Requirement: ${name}`, "O sistema SHALL fazer algo.", "", ...scenarios.flatMap((s) => [`#### Scenario: ${s}`, `- **WHEN** ${s}`, "- **THEN** ok", ""])].join("\n");

function change(name: string, specs: Record<string, string>): string {
  const root = join(dir, name);
  for (const [cap, text] of Object.entries(specs)) {
    mkdirSync(join(root, "specs", cap), { recursive: true });
    writeFileSync(join(root, "specs", cap, "spec.md"), text);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

describe("1.1 cenários das delta specs", () => {
  test("Cenários de duas capacidades: 6 + 2, grouped by capability and requirement, with WHEN/THEN text", () => {
    const root = change("duas", {
      "git-repositories": [
        "# Spec Delta",
        "",
        "## Purpose",
        "",
        "Git pela app.",
        "",
        "## ADDED Requirements",
        "",
        requirement("Estado", ["A", "B"]),
        requirement("Init", ["C", "D", "E", "F"]),
      ].join("\n"),
      "change-apply": ["## MODIFIED Requirements", "", requirement("Revisar", ["Aceitar", "Desfazer"])].join("\n"),
    });
    const scenarios = changeScenarios(root);
    expect(scenarios.map((s) => s.id)).toEqual([
      "change-apply/Revisar/Aceitar",
      "change-apply/Revisar/Desfazer",
      "git-repositories/Estado/A",
      "git-repositories/Estado/B",
      "git-repositories/Init/C",
      "git-repositories/Init/D",
      "git-repositories/Init/E",
      "git-repositories/Init/F",
    ]);
    expect(scenarios[0]).toEqual({
      id: "change-apply/Revisar/Aceitar",
      capability: "change-apply",
      requirement: "Revisar",
      name: "Aceitar",
      text: "- **WHEN** Aceitar\n- **THEN** ok",
    });
  });

  test("REMOVED and RENAMED sections are left out; headings in code fences are not headings", () => {
    const spec = [
      "## ADDED Requirements",
      "",
      "### Requirement: Novo",
      "",
      "#### Scenario: Fica",
      "- **WHEN** x",
      "```",
      "#### Scenario: Dentro do bloco",
      "```",
      "- **THEN** y",
      "",
      "## REMOVED Requirements",
      "",
      requirement("Velho", ["Sai"]),
      "## RENAMED Requirements",
      "- FROM: `### Requirement: A`",
      "- TO: `### Requirement: B`",
    ].join("\n");
    const scenarios = parseScenarios("cap", spec);
    expect(scenarios.map((s) => s.name)).toEqual(["Fica"]);
    expect(scenarios[0]!.text).toContain("#### Scenario: Dentro do bloco");
  });

  test("a nested capability keeps its full path", () => {
    const root = change("aninhada", { "identity/user-auth": ["## ADDED Requirements", "", requirement("Login", ["Entrar"])].join("\n") });
    expect(changeScenarios(root).map((s) => s.id)).toEqual(["identity/user-auth/Login/Entrar"]);
  });

  test("Change sem cenários: only REMOVED requirements, or no specs folder at all", () => {
    const removed = change("removidos", { cap: ["## REMOVED Requirements", "", "### Requirement: X", "**Reason**: r", "**Migration**: m"].join("\n") });
    expect(changeScenarios(removed)).toEqual([]);
    const none = change("sem-specs", {});
    expect(changeScenarios(none)).toEqual([]);
  });
});
