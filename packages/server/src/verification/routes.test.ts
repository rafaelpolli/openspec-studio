import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOKEN_HEADER, type VerificationState } from "@studio/shared";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { snapshot } from "../apply/snapshot.ts";
import { EventBus } from "../events.ts";
import { gitSandbox } from "../git/testing.ts";
import { createToken } from "../security.ts";
import { deltaSpec, evidence, git, verificationSetup } from "./testing.ts";

setDefaultTimeout(60_000);

const cleanups: (() => void)[] = [];
// Commits made by the app use a throwaway HOME, never the user's ~/.gitconfig.
const gitBox = gitSandbox("studio-verify-git-");
gitBox.globalIdentity("Studio Teste", "teste@x");
cleanups.push(() => rmSync(gitBox.dir, { recursive: true, force: true }));
afterAll(() => cleanups.forEach((c) => c()));

async function setup(opts: Parameters<typeof verificationSetup>[0] = {}) {
  const t = await verificationSetup(opts);
  cleanups.push(() => {
    t.close();
    rmSync(t.dir, { recursive: true, force: true });
  });
  const token = createToken();
  const app = createApp({ token, allowedOrigins: [], events: new EventBus(), workspaces: t.workspaces, verification: t.service });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/workspaces/${t.ws.id}/changes/c${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const item = (id: string) => `/verification/items/${encodeURIComponent(id)}`;
  /** Records the tree from before the change as the apply would: the `before` of its first task. */
  const recordBefore = (wrong: string) => {
    const file = join(t.root, "src", "soma.ts");
    const right = readFileSync(file, "utf8");
    writeFileSync(file, wrong);
    const before = snapshot(t.root);
    writeFileSync(file, right);
    t.applyRepo.save(t.ws.id, "c", { taskId: "1.1", position: 1, status: "aceita", before: { [t.root]: before } });
  };
  return { ...t, call, item, recordBefore };
}

const PASSA = "calc/Somar/Passa";

describe("5.2 provar por item", () => {
  test("Prova forte through the route; 409 for an item that is not covered, and while the proof runs", async () => {
    const t = await setup({
      scenarios: ["Passa", "Sem teste"],
      trace: () => ({ items: [evidence(PASSA, 5, "Passa: soma dois números")] }),
    });
    t.recordBefore("export const soma = (a: number, b: number) => a - b;\n");
    expect((await t.call("POST", "/verification")).status).toBe(202);
    await t.service.settled(t.ws.id, "c");
    expect((await t.call("POST", `${t.item("calc/Somar/Sem teste")}/proof`)).status).toBe(409);
    const started = await t.call("POST", `${t.item(PASSA)}/proof`);
    expect(started.status).toBe(202);
    const running = (started.json as VerificationState).report!.items.find((i) => i.id === PASSA)!;
    expect(running.proof).toEqual({ status: "rodando" });
    expect((await t.call("POST", `${t.item(PASSA)}/proof`)).status).toBe(409);
    expect(t.service.busy(t.ws.id)).toBe(true);
    await t.service.settled(t.ws.id, "c");
    const state = (await t.call("GET", "/verification")).json as VerificationState;
    expect(state.report!.items.find((i) => i.id === PASSA)!.proof).toMatchObject({ status: "concluida", result: "forte" });
    expect(readFileSync(join(t.changeDir, "verification.md"), "utf8")).toContain("| coberto | forte |");
    expect(t.service.busy(t.ws.id)).toBe(false);
  });

  test("Teste que não depende da change: fraca, which keeps the verdict at CONCERNS", async () => {
    const t = await setup({ trace: () => ({ items: [evidence(PASSA, 5, "Passa: soma dois números")] }) });
    t.recordBefore(readFileSync(join(t.root, "src", "soma.ts"), "utf8"));
    await t.verify();
    expect(t.service.state(t.ws.id, "c").report!.verdict).toBe("PASS");
    await t.call("POST", `${t.item(PASSA)}/proof`);
    await t.service.settled(t.ws.id, "c");
    const state = t.service.state(t.ws.id, "c");
    expect(state.report!.items[0]!.proof?.result).toBe("fraca");
    expect(state.report!.verdict).toBe("CONCERNS");
  });

  test("Sem retrato anterior: the proof is not offered, with the reason", async () => {
    const t = await setup({ trace: () => ({ items: [evidence(PASSA, 5, "Passa: soma dois números")] }) });
    await t.verify();
    const state = (await t.call("GET", "/verification")).json as VerificationState;
    expect(state.proofUnavailable).toBe("as tasks desta change não foram executadas pela app, então não há retrato de antes da change");
    const refused = await t.call("POST", `${t.item(PASSA)}/proof`);
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toBe(state.proofUnavailable);
  });
});

describe("6.1 arquivar com o portão", () => {
  const PASS_TRACE = () => ({ items: [evidence(PASSA, 5, "Passa: soma dois números")] });

  test("each gate reason refuses with 409: no report, stale, FAIL, CONCERNS without justification", async () => {
    let trace: () => unknown = () => ({ items: [evidence(PASSA, 8, "Falha: sempre falha")] });
    const t = await setup({ scenarios: ["Passa", "Manual"], trace: () => trace() });
    const archive = () => t.call("POST", "/archive");
    let res = await archive();
    expect([res.status, res.json.error.message]).toEqual([409, "verifique a change antes de arquivar"]);
    await t.verify();
    res = await archive();
    expect([res.status, res.json.error.message]).toEqual([409, "há testes falhando: corrija e verifique de novo"]);
    trace = () => ({ items: [evidence(PASSA, 5, "Passa: soma dois números"), { id: "calc/Somar/Manual", kind: "manual" }] });
    await t.verify();
    res = await archive();
    expect([res.status, res.json.error.message]).toEqual([409, "justifique os itens que deixam o veredito em CONCERNS (1)"]);
    expect((await t.call("GET", "/verification")).json.archive.missing).toEqual(["calc/Somar/Manual"]);
    expect((await t.call("PUT", `${t.item("calc/Somar/Manual")}/justification`, { text: "visto à mão" })).status).toBe(200);
    writeFileSync(join(t.root, "src", "novo.ts"), "x\n");
    res = await archive();
    expect([res.status, res.json.error.message]).toEqual([409, "o código ou os artefatos mudaram depois da verificação: verifique de novo"]);
    expect(existsSync(t.changeDir)).toBe(true);
  });

  test("PASS: the change moves to archive/ with verification.md, the main specs get the delta, the records are dropped", async () => {
    const t = await setup({ trace: PASS_TRACE });
    t.applyRepo.save(t.ws.id, "c", { taskId: "1.1", position: 1, status: "aceita", before: {} });
    await t.verify();
    const res = await t.call("POST", "/archive");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ specsUpdated: true });
    expect(res.json.commit).toBeUndefined();
    expect(existsSync(t.changeDir)).toBe(false);
    const archived = readdirSync(join(t.root, "openspec", "changes", "archive")).filter((n) => !n.startsWith("."));
    expect(archived).toEqual([res.json.archivedAs]);
    expect(readFileSync(join(t.root, "openspec", "changes", "archive", archived[0]!, "verification.md"), "utf8")).toContain("**PASS**");
    expect(readFileSync(join(t.root, "openspec", "specs", "calc", "spec.md"), "utf8")).toContain("#### Scenario: Passa");
    expect(t.applyRepo.list(t.ws.id, "c")).toEqual([]);
    expect(t.repo.lastAttempt(t.ws.id, "c")).toBeUndefined();
  });

  test("Falha do archive: the OpenSpec message comes back and the change stays where it was", async () => {
    // A MODIFIED requirement on a capability without a main spec is refused by `openspec archive`.
    const spec = deltaSpec("Somar", ["Passa"]).replace("## ADDED Requirements", "## MODIFIED Requirements");
    const t = await setup({ spec, trace: PASS_TRACE });
    await t.verify();
    const res = await t.call("POST", "/archive");
    expect(res.status).toBe(502);
    expect(res.json.error.message).toBeTruthy();
    expect(existsSync(join(t.changeDir, "verification.md"))).toBe(true);
    const archive = join(t.root, "openspec", "changes", "archive");
    expect(existsSync(archive) ? readdirSync(archive).filter((n) => n.endsWith("-c")) : []).toEqual([]);
  });
});

describe("6.2 arquivar e commitar", () => {
  const PASS_TRACE = () => ({ items: [evidence(PASSA, 5, "Passa: soma dois números")] });
  const files = (root: string) => git(root, "show", "--no-renames", "--name-only", "--format=", "HEAD").trim().split("\n").sort();

  test("Commit só do archive: the moved change and the main spec; a pending README stays pending", async () => {
    const t = await setup({ trace: PASS_TRACE, git: gitBox.client });
    writeFileSync(join(t.root, "README.md"), "editado pelo usuário\n");
    await t.verify();
    expect((await t.call("GET", "/verification")).json.archive.git).toBe(true);
    const res = await t.call("POST", "/archive", { commit: { message: "archive: c" } });
    expect(res.status).toBe(200);
    expect(res.json.commit).toMatch(/^[0-9a-f]{40}$/);
    const archived = `openspec/changes/archive/${res.json.archivedAs}`;
    expect(files(t.root)).toEqual(
      [
        "openspec/changes/c/.openspec.yaml",
        "openspec/changes/c/specs/calc/spec.md",
        "openspec/changes/c/tasks.md",
        `${archived}/.openspec.yaml`,
        `${archived}/specs/calc/spec.md`,
        `${archived}/tasks.md`,
        `${archived}/verification.md`,
        "openspec/specs/calc/spec.md",
      ].sort(),
    );
    expect(git(t.root, "log", "-1", "--format=%an|%s").trim()).toBe("Studio Teste|archive: c");
    expect(git(t.root, "status", "--porcelain").trim()).toBe("?? README.md");
  });

  test("Hook recusa: the change stays archived, 422 with archived; the retry without hooks commits the same files", async () => {
    const t = await setup({ trace: PASS_TRACE, git: gitBox.client });
    writeFileSync(join(t.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho recusado pelo hook\nexit 1\n", { mode: 0o755 });
    await t.verify();
    const res = await t.call("POST", "/archive", { commit: { message: "archive: c" } });
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ archived: true, error: { code: "git_failed", kind: "hook" } });
    expect(res.json.error.output).toContain("recusado pelo hook");
    expect(existsSync(t.changeDir)).toBe(false);
    expect(git(t.root, "log", "-1", "--format=%s").trim()).toBe("init");
    const retry = await t.call("POST", "/archive/commit", { message: "archive: c", noVerify: true });
    expect(retry.status).toBe(200);
    expect(git(t.root, "log", "-1", "--format=%s").trim()).toBe("archive: c");
    expect(files(t.root)).toContain("openspec/specs/calc/spec.md");
    expect(git(t.root, "status", "--porcelain").trim()).toBe("");
    expect((await t.call("POST", "/archive/commit", { message: "x" })).status).toBe(409);
  });
});
