import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SpecScenario } from "@studio/shared";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseTasks } from "../openspec/tasks.ts";
import { addTestTask } from "./report.ts";
import { VerificationStateError } from "./service.ts";
import { evidence, verificationSetup } from "./testing.ts";

setDefaultTimeout(60_000);

const scenario: SpecScenario = {
  id: "change-apply/Revisar o resultado de uma task/Índice do usuário",
  capability: "change-apply",
  requirement: "Revisar o resultado de uma task",
  name: "Índice do usuário",
  text: "",
};

describe("4.4 gerar task de teste", () => {
  test("Task acrescentada: a new 'Verificação' group with the next number", () => {
    const tasks = "# Tasks\n\n## 1. Core\n\n- [x] 1.1 A\n\n## 2. Web\n\n- [x] 2.1 B\n  - detalhe\n";
    const { markdown, id } = addTestTask(tasks, scenario);
    expect(id).toBe("3.1");
    expect(markdown).toBe(
      `${tasks}\n## 3. Verificação\n\n- [ ] 3.1 Teste automatizado para o cenário "Índice do usuário" (change-apply / Revisar o resultado de uma task)\n`,
    );
    expect(parseTasks(markdown).sections.at(-1)!.tasks[0]).toMatchObject({ id: "3.1", done: false });
  });

  test("an existing 'Verificação' group gets the task at its end, before the next group", () => {
    const tasks = "# Tasks\n\n## 1. Core\n\n- [x] 1.1 A\n\n## 2. Verificação\n\n- [x] 2.1 Teste X\n  - sub\n\n## 3. Docs\n\n- [ ] 3.1 README\n";
    const { markdown, id } = addTestTask(tasks, scenario);
    expect(id).toBe("2.2");
    expect(markdown).toContain("  - sub\n- [ ] 2.2 Teste automatizado para o cenário \"Índice do usuário\"");
    expect(markdown).toContain("(change-apply / Revisar o resultado de uma task)\n\n## 3. Docs\n");
  });
});

describe("4.4 relatório e ações por item", async () => {
  const t = await verificationSetup({
    scenarios: ["Passa", "Manual", "Sem teste"],
    trace: () => ({ items: [evidence("calc/Somar/Passa", 5, "Passa: soma dois números"), { id: "calc/Somar/Manual", kind: "manual" }] }),
  });
  afterAll(() => {
    t.close();
    rmSync(t.dir, { recursive: true, force: true });
  });
  const report = () => readFileSync(join(t.changeDir, "verification.md"), "utf8");

  test("verification.md: verdict, the table by capability and requirement", async () => {
    await t.verify();
    const md = report();
    expect(md).toStartWith("# Verificação: c\n\n- Veredito: **CONCERNS**\n");
    expect(md).toContain("## calc\n\n### Somar\n\n| Cenário | Evidência | Resultado | Prova |\n|---|---|---|---|\n");
    expect(md).toContain('| Passa | `app/src/soma.test.ts:5` "Passa: soma dois números" | coberto | - |');
    expect(md).toContain("| Manual | - | manual | - |");
    expect(md).toContain("| Sem teste | - | sem teste | - |");
  });

  test("Justificativa registrada; only items that cause CONCERNS take one", async () => {
    const state = t.service.justify(t.ws.id, "c", "calc/Somar/Sem teste", "coberto pelo E2E manual de release");
    expect(state.archive.missing).toEqual(["calc/Somar/Manual"]);
    expect(report()).toContain("- **Sem teste**: justificativa — coberto pelo E2E manual de release");
    expect(() => t.service.justify(t.ws.id, "c", "calc/Somar/Passa", "x")).toThrow(VerificationStateError);
  });

  test("Cenário manual: CONCERNS until it is checked, then PASS (the other concern is justified, not resolved)", async () => {
    expect(() => t.service.check(t.ws.id, "c", "calc/Somar/Passa")).toThrow("só um item de verificação manual");
    let state = t.service.check(t.ws.id, "c", "calc/Somar/Manual", "olhei a tela");
    expect(state.report!.verdict).toBe("CONCERNS"); // "Sem teste" is justified, still a concern
    expect(report()).toContain("| Manual | - | manual (conferido) | - |");
    expect(report()).toContain("- **Manual**: conferido — olhei a tela");
    expect(state.archive).toMatchObject({ allowed: true, missing: [] });
    state = t.service.uncheck(t.ws.id, "c", "calc/Somar/Manual");
    expect(state.archive.missing).toEqual(["calc/Somar/Manual"]);
  });

  test("Gerar task de teste: tasks.md gets the task, and the report becomes stale", async () => {
    expect(() => t.service.addTestTask(t.ws.id, "c", "calc/Somar/Passa")).toThrow(VerificationStateError);
    const { state, taskId } = t.service.addTestTask(t.ws.id, "c", "calc/Somar/Sem teste");
    expect(taskId).toBe("2.1");
    expect(readFileSync(join(t.changeDir, "tasks.md"), "utf8")).toContain('- [ ] 2.1 Teste automatizado para o cenário "Sem teste" (calc / Somar)');
    expect(state.stale).toBe(true);
  });

  test("Só um item manual: PASS once it is checked", async () => {
    const only = await verificationSetup({ scenarios: ["Manual"], trace: () => ({ items: [{ id: "calc/Somar/Manual", kind: "manual" }] }) });
    try {
      expect((await only.verify()).report!.verdict).toBe("CONCERNS");
      expect(only.service.check(only.ws.id, "c", "calc/Somar/Manual").report!.verdict).toBe("PASS");
    } finally {
      only.close();
      rmSync(only.dir, { recursive: true, force: true });
    }
  });
});
