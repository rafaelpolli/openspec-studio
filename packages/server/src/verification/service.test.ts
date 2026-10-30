import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { VerificationItem } from "@studio/shared";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApplyService, ApplyStateError } from "../apply/service.ts";
import { GitService } from "../git/service.ts";
import { GitClient } from "../git/exec.ts";
import { EventBus } from "../events.ts";
import { deltaSpec, evidence, verificationSetup } from "./testing.ts";
import { VerificationStateError } from "./service.ts";

setDefaultTimeout(60_000);

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));

async function setup(opts: Parameters<typeof verificationSetup>[0]) {
  const t = await verificationSetup(opts);
  cleanups.push(() => {
    t.close();
    rmSync(t.dir, { recursive: true, force: true });
  });
  return t;
}

const id = (scenario: string) => `calc/Somar/${scenario}`;
const byId = (items: readonly VerificationItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));

describe("4.2 serviço de verificação", () => {
  test("rastreio, conferência e execução: one run per test, a verdict from the items, and verification.md", async () => {
    const scenarios = ["Passa", "Passa de novo", "Falha", "Manual", "Sem teste", "Inválida", "Esquecido"];
    const t = await setup({
      scenarios,
      trace: () => ({
        items: [
          evidence(id("Passa"), 5, "Passa: soma dois números"),
          evidence(id("Passa de novo"), 4, "soma > Passa: soma dois números"),
          evidence(id("Falha"), 8, "Falha: sempre falha"),
          { id: id("Manual"), kind: "manual", note: "visual" },
          { id: id("Sem teste"), kind: "sem-teste" },
          evidence(id("Inválida"), 1, "Não existe"),
        ],
      }),
    });
    const state = await t.verify();
    expect(state.running).toBeUndefined();
    const report = state.report!;
    expect(report.status).toBe("concluida");
    expect(report.verdict).toBe("FAIL");
    const items = byId(report.items);
    expect(items[id("Passa")]).toMatchObject({ result: "coberto", command: ["bun", "test", "./src/soma.test.ts", "-t", "Passa: soma dois números"] });
    // The describe prefix is dropped, so both scenarios share one run.
    expect(items[id("Passa de novo")]).toMatchObject({ result: "coberto", evidence: { name: "Passa: soma dois números" } });
    expect(items[id("Falha")]!.result).toBe("falhou");
    expect(items[id("Falha")]!.output).toContain("Falha: sempre falha");
    expect(items[id("Manual")]).toMatchObject({ result: "manual", note: "visual" });
    expect(items[id("Sem teste")]!.result).toBe("sem-teste");
    expect(items[id("Inválida")]).toMatchObject({ result: "evidencia-invalida", reason: "o nome do teste não aparece perto da linha 1" });
    expect(items[id("Esquecido")]!.result).toBe("sem-teste");
    expect(t.execs).toHaveLength(2);
    expect(t.events.filter((e) => e.type === "verification-changed").length).toBeGreaterThan(3);
    const md = readFileSync(join(t.changeDir, "verification.md"), "utf8");
    expect(md).toContain("- Veredito: **FAIL**");
    expect(md).toContain("| Falha | `app/src/soma.test.ts:8` \"Falha: sempre falha\" | falhou | - |");
    // The agent's session could only write its work folder and run nothing.
    const perms = [...t.engine.permissions.values()][0]!;
    expect(perms.filter((r) => r.permission === "edit" && r.action === "allow").every((r) => !r.pattern.includes("openspec"))).toBe(true);
    expect(perms).toContainEqual({ permission: "bash", pattern: "*", action: "deny" });
  });

  test("Tudo coberto with tasks pending: CONCERNS from the tasks-pendentes item; PASS once the tasks are done", async () => {
    const t = await setup({
      tasks: "# Tasks\n\n## 1. Core\n\n- [x] 1.1 Somar\n- [ ] 1.2 Subtrair\n",
      trace: () => ({ items: [evidence(id("Passa"), 5, "Passa: soma dois números")] }),
    });
    const first = await t.verify();
    expect(first.report!.verdict).toBe("CONCERNS");
    expect(byId(first.report!.items)["tasks-pendentes"]).toMatchObject({ kind: "tasks-pendentes", pendingTasks: ["1.2"] });
    writeFileSync(join(t.changeDir, "tasks.md"), "# Tasks\n\n## 1. Core\n\n- [x] 1.1 Somar\n- [x] 1.2 Subtrair\n");
    expect((await t.verify()).report!.verdict).toBe("PASS");
  });

  test("Change sem cenários: PASS without items and without an agent session", async () => {
    const t = await setup({ spec: "## REMOVED Requirements\n\n### Requirement: Velho\n**Reason**: r\n**Migration**: m\n" });
    const state = await t.verify();
    expect(state.report).toMatchObject({ verdict: "PASS", items: [] });
    expect(t.engine.prompts).toHaveLength(0);
    expect(readFileSync(join(t.changeDir, "verification.md"), "utf8")).toContain("A change não tem cenários a verificar.");
  });

  test("Tasks em aberto: unavailable with the reason, and run is refused", async () => {
    const t = await setup({});
    t.applyRepo.save(t.ws.id, "c", { taskId: "2.1", position: 1, status: "aguardando-revisao", before: {} });
    const state = t.service.state(t.ws.id, "c");
    expect(state.canStart).toBe(false);
    expect(state.startReason).toBe("aceite ou desfaça antes as tasks em aberto (2.1)");
    expect(t.service.run(t.ws.id, "c")).rejects.toThrow(VerificationStateError);
    t.applyRepo.remove(t.ws.id, "c", "2.1");
    t.setApplyBusy(true);
    expect(t.service.state(t.ws.id, "c").startReason).toBe("há um apply rodando ou aguardando revisão neste workspace");
  });

  test("Interromper: no new report, the previous one stays; the agent run is cancelled", async () => {
    let hang = false;
    const t = await setup({ trace: () => (hang ? "hang" : { items: [evidence(id("Passa"), 5, "Passa: soma dois números")] }) });
    const first = (await t.verify()).report!;
    hang = true;
    await t.service.run(t.ws.id, "c");
    for (let i = 0; i < 100 && t.engine.prompts.length < 2; i++) await Bun.sleep(10);
    expect(t.service.busy(t.ws.id)).toBe(true);
    const stopped = await t.service.stop(t.ws.id, "c");
    await t.service.settled(t.ws.id, "c");
    expect(stopped.running).toBeUndefined();
    const state = t.service.state(t.ws.id, "c");
    expect(state.report!.id).toBe(first.id);
    expect(state.lastError).toBe("A verificação foi interrompida");
    expect(t.engine.aborted).toHaveLength(1);
    expect(t.service.busy(t.ws.id)).toBe(false);
  });

  test("an agent failure or an invalid trace.json ends without a report, with the message", async () => {
    let answer: unknown = "fail";
    const t = await setup({ trace: () => answer });
    expect((await t.verify()).lastError).toContain("sem chave");
    answer = "isto não é json";
    const state = await t.verify();
    expect(state.report).toBeUndefined();
    expect(state.lastError).toBe("o agente escreveu um trace.json que não é JSON");
  });

  test("Apply bloqueado durante a verificação; Commitar pendências too", async () => {
    const t = await setup({ trace: () => "hang" });
    await t.service.run(t.ws.id, "c");
    const verifying = (wsId: string) => t.service.busy(wsId);
    const apply = new ApplyService(t.workspaces, {} as never, {} as never, t.applyRepo, { get: () => [] } as never, new GitClient(), verifying);
    expect(apply.run(t.ws.id, "c", "proxima", true)).rejects.toThrow(
      new ApplyStateError("a change está sendo verificada: espere a verificação terminar ou pare-a"),
    );
    const git = new GitService(t.workspaces, new GitClient(), new EventBus(), () => false, verifying);
    expect(git.commitPending(t.ws.id, t.root, { message: "x" })).rejects.toThrow("está sendo verificada");
    expect((await git.state(t.ws.id)).busy).toBe(true);
    await t.service.stop(t.ws.id, "c");
    await t.service.settled(t.ws.id, "c");
    expect(existsSync(join(t.changeDir, "verification.md"))).toBe(false);
  });
});
