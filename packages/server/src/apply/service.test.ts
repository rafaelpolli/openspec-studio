import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOKEN_HEADER, type ApplyState, type PermissionReply, type RegisterWorkspaceResult } from "@studio/shared";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { AgentRunner } from "../engine/runner.ts";
import { ChangeSessions } from "../engine/sessions.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createToken } from "../security.ts";
import { FakeEngine } from "../testing/fake-engine.ts";
import { sandbox } from "../testing/fixture.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import { CommandList, detectCommands } from "./commands.ts";
import { ApplyRepo } from "./repo.ts";
import { fixedRunner } from "./engines.ts";
import { ApplyService } from "./service.ts";
import { gitSandbox } from "../git/testing.ts";

setDefaultTimeout(60_000);

// Commits made by the app use a throwaway HOME, never the user's ~/.gitconfig.
const gitBox = gitSandbox("studio-apply-git-");
gitBox.globalIdentity("Studio Teste", "teste@x");
afterAll(() => rmSync(gitBox.dir, { recursive: true, force: true }));

const { dir, cli } = sandbox("studio-apply-");
const adapter = new OpenSpecAdapter(cli);
const watcher = new WorkspaceWatcher(new EventBus());
afterAll(() => {
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
});

const TASKS = "# Tasks\n\n## 1. Core\n\n- [ ] 1.1 Criar a\n- [ ] 1.2 Criar b\n- [ ] 1.3 Criar c\n";

/** What the scripted agent does for a task, keyed by task id. */
interface Step {
  /** Files to write, relative to the member (or absolute). */
  write?: Record<string, string>;
  /** Asks permission for this command first and waits for the answer. */
  ask?: string;
  fail?: string;
  /** Never finishes on its own (until aborted). */
  hang?: boolean;
}

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe" }).stdout.toString();
}

function folder(path: string, files: Record<string, string>, opts: { git?: boolean } = {}): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  mkdirSync(path, { recursive: true });
  if (opts.git !== false) {
    git(path, "init", "-q");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", "init", "--allow-empty");
  }
  return path;
}

let counter = 0;

async function setup(steps: Record<string, Step> = {}, opts: { git?: boolean; dirty?: boolean; multi?: boolean; storeGit?: boolean } = {}) {
  const base = join(dir, `case-${++counter}`);
  mkdirSync(base, { recursive: true });
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), adapter, watcher);
  const engine = new FakeEngine();
  const replies = new Map<string, (reply: PermissionReply) => void>();
  engine.replyPermission = async (requestId, _dir, reply, message) => {
    engine.permissionReplies.push({ requestId, reply, ...(message ? { message } : {}) });
    replies.get(requestId)?.(reply);
  };
  let members: string[] = [];
  const hanging = new Map<string, () => void>();
  engine.abort = async (sessionId) => {
    engine.aborted.push(sessionId);
    hanging.get(sessionId)?.();
  };
  engine.onPrompt = async (call, e) => {
    const id = /^# (?:Task|Ajuste na task) ([\d.]+)/.exec(call.text)?.[1] ?? "";
    const adjust = call.text.startsWith("# Ajuste");
    const step = adjust ? { write: { [`ajuste-${id}.txt`]: "ajuste\n" } } : (steps[id] ?? { write: { [`t${id}.txt`]: `${id}\n` } });
    void (async () => {
      await Bun.sleep(5);
      if (step.hang) {
        const abort = () => e.emit({ kind: "error", sessionId: call.sessionId, name: "MessageAbortedError", message: "aborted" });
        if (engine.aborted.includes(call.sessionId)) abort();
        else hanging.set(call.sessionId, abort);
        return;
      }
      if (step.ask) {
        const requestId = `per_${id}`;
        const answer = new Promise<PermissionReply>((resolve) => replies.set(requestId, resolve));
        e.emit({ kind: "permission", sessionId: call.sessionId, directory: call.opts.directory, request: { requestId, permission: "bash", patterns: [step.ask] } });
        if ((await answer) === "reject" && engine.aborted.includes(call.sessionId)) return;
      }
      if (step.fail) return e.emit({ kind: "error", sessionId: call.sessionId, name: "ProviderAuthError", message: step.fail });
      for (const [file, content] of Object.entries(step.write ?? {})) {
        // "@1/src/x.ts" is a file in the second member.
        const member = /^@(\d)\//.exec(file);
        const path = file.startsWith("/") ? file : member ? join(members[Number(member[1])]!, file.slice(3)) : join(members[0]!, file);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, content);
        e.emit({ kind: "file", directory: call.opts.directory, path });
      }
      e.emit({ kind: "text", sessionId: call.sessionId, partId: `p${id}`, delta: `Fiz a task ${id}.` });
      e.emit({ kind: "idle", sessionId: call.sessionId });
    })();
  };
  const sessions = new ChangeSessions(db, engine);
  const runner = new AgentRunner(engine, sessions, new EventBus());
  const apply = new ApplyService(workspaces, adapter, fixedRunner(runner), new ApplyRepo(db), new CommandList(db), gitBox.client);
  const token = createToken();
  const app = createApp({ token, allowedOrigins: [], events: new EventBus(), workspaces, apply });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  let root: string;
  let regBody: unknown;
  if (opts.multi) {
    root = join(base, "store");
    await adapter.storeSetup(base, `store-${counter}`, root, { initGit: false });
    const api = folder(join(base, "repo-api"), { "src/auth.ts": "auth\n", "package.json": '{"scripts":{"test":"bun test"}}', "bun.lock": "" });
    const web = folder(join(base, "repo-web"), { "src/login.ts": "login\n" });
    members = [api, web];
    regBody = { kind: "multi", storeId: `store-${counter}`, members: [api, web] };
  } else {
    root = folder(join(base, "app"), { "src/main.ts": "main\n", "package.json": '{"scripts":{"test":"x","build":"y","dev":"z"}}' }, { git: false });
    await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
    members = [root];
    regBody = { kind: "mono", path: root };
  }
  await cli.run(["new", "change", "c"], { cwd: root, ...(opts.multi ? { store: `store-${counter}` } : {}) });
  writeFileSync(join(root, "openspec/changes/c/tasks.md"), TASKS);
  if (!opts.multi && opts.git !== false) {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  if (opts.multi && opts.storeGit) {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  if (opts.dirty) writeFileSync(join(members[0]!, "src/main.ts"), "editado pelo usuário\n");

  const reg = await call("POST", "/workspaces", regBody);
  const ws = (reg.json as RegisterWorkspaceResult).workspace.id;
  const path = `/workspaces/${ws}/changes/c/apply`;
  const state = async () => (await call("GET", path)).json as ApplyState;
  const statuses = async () => Object.fromEntries((await state()).tasks.map((t) => [t.id, t.status]));
  const runAndWait = async (mode: "proxima" | "todas", confirmed = false) => {
    const res = await call("POST", `${path}/run`, { mode, confirmed });
    await apply.settled(ws);
    return res;
  };
  const waitFor = async (check: (s: ApplyState) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const s = await state();
      if (check(s)) return s;
      await Bun.sleep(10);
    }
    throw new Error("estado esperado não chegou");
  };
  return { root, members, ws, path, call, state, statuses, runAndWait, waitFor, apply, engine, sessions, tasksFile: join(root, "openspec/changes/c/tasks.md") };
}

describe("3.2 checagem antes da execução", () => {
  test("a clean workspace in Git runs without confirmation", async () => {
    const t = await setup();
    expect((await t.call("GET", `/workspaces/${t.ws}/apply/check`)).json).toEqual({ warnings: [] });
    expect((await t.runAndWait("proxima")).status).toBe(202);
    expect((await t.statuses())["1.1"]).toBe("aguardando-revisao");
  });

  test("Alterações pendentes: warned, and only runs once confirmed", async () => {
    const t = await setup({}, { dirty: true });
    const refused = await t.call("POST", `${t.path}/run`, { mode: "proxima" });
    expect(refused.status).toBe(409);
    expect(refused.json.warnings).toEqual([{ member: "app", kind: "alteracoes-pendentes" }]);
    expect(t.engine.prompts).toHaveLength(0);
    expect((await t.runAndWait("proxima", true)).status).toBe(202);
    expect((await t.statuses())["1.1"]).toBe("aguardando-revisao");
  });

  test("Membro sem Git: warned; the task runs without undo and lists the files written", async () => {
    const t = await setup({}, { git: false });
    const refused = await t.call("POST", `${t.path}/run`, { mode: "proxima" });
    expect(refused.json.warnings).toEqual([{ member: "app", kind: "sem-git" }]);
    await t.runAndWait("proxima", true);
    const task = (await t.state()).tasks[0]!;
    expect(task.diff).toEqual([{ member: "app", git: false, files: [], written: [join(t.root, "t1.1.txt")] }]);
  });
});

describe("4.1 fila e estados", () => {
  test("Executar todas: runs the tasks in order, each waiting for review with its own diff", async () => {
    const t = await setup();
    await t.runAndWait("todas");
    const s = await t.state();
    expect(s.tasks.map((x) => [x.id, x.status])).toEqual([
      ["1.1", "aguardando-revisao"],
      ["1.2", "aguardando-revisao"],
      ["1.3", "aguardando-revisao"],
    ]);
    expect(s.tasks.map((x) => x.diff?.[0]?.files.map((f) => f.path))).toEqual([["t1.1.txt"], ["t1.2.txt"], ["t1.3.txt"]]);
    expect(s.tasks[1]!.summary).toBe("Fiz a task 1.2.");
    expect(t.engine.prompts.map((p) => p.text.split("\n")[0])).toEqual(["# Task 1.1 da change `c`", "# Task 1.2 da change `c`", "# Task 1.3 da change `c`"]);
    // tasks.md is untouched: only acceptance marks a task.
    expect(readFileSync(t.tasksFile, "utf8")).toBe(TASKS);
    // One apply session, separate from planning, for every task.
    expect(new Set(t.engine.prompts.map((p) => p.sessionId)).size).toBe(1);
    expect(t.sessions.isApply(t.engine.prompts[0]!.sessionId)).toBe(true);
  });

  test("Executar próxima runs only the next pending task", async () => {
    const t = await setup();
    await t.runAndWait("proxima");
    expect(await t.statuses()).toEqual({ "1.1": "aguardando-revisao", "1.2": "pendente", "1.3": "pendente" });
  });

  test("an error stops the queue; the failed task is incomplete with the message", async () => {
    const t = await setup({ "1.2": { fail: "invalid api key" } });
    await t.runAndWait("todas");
    const s = await t.state();
    expect(s.tasks.map((x) => x.status)).toEqual(["aguardando-revisao", "incompleta", "pendente"]);
    expect(s.tasks[1]!.error).toContain("autenticação");
  });

  test("Parar: the running task is incomplete, the next one does not start", async () => {
    const t = await setup({ "1.2": { hang: true } });
    await t.call("POST", `${t.path}/run`, { mode: "todas" });
    await t.waitFor((s) => s.tasks[1]!.status === "rodando");
    const stopped = (await t.call("POST", `${t.path}/stop`)).json as ApplyState;
    expect(stopped.tasks.map((x) => x.status)).toEqual(["aguardando-revisao", "incompleta", "pendente"]);
    expect(stopped.tasks[1]!.error).toBe("A task foi interrompida");
    expect(stopped.running).toBe(false);
  });

  test("a pending permission request pauses the task until answered", async () => {
    const t = await setup({ "1.1": { ask: "bun run lint", write: { "a.txt": "a\n" } } });
    await t.call("POST", `${t.path}/run`, { mode: "proxima" });
    const waiting = await t.waitFor((s) => s.tasks[0]!.status === "aguardando-permissao");
    expect(waiting.permission).toEqual({ requestId: "per_1.1", permission: "bash", patterns: ["bun run lint"] });
    const res = await t.call("POST", `${t.path}/permission`, { requestId: "per_1.1", reply: "once" });
    expect(res.status).toBe(200);
    await t.apply.settled(t.ws);
    expect((await t.statuses())["1.1"]).toBe("aguardando-revisao");
    expect(t.engine.permissionReplies).toEqual([{ requestId: "per_1.1", reply: "once" }]);
    expect((await t.call("GET", `/workspaces/${t.ws}/apply/commands`)).json.commands).not.toContain("bun run lint");
  });

  test("Parar com pedido pendente: the request is rejected and the task is incomplete", async () => {
    const t = await setup({ "1.1": { ask: "rm -rf build" } });
    await t.call("POST", `${t.path}/run`, { mode: "proxima" });
    await t.waitFor((s) => s.tasks[0]!.status === "aguardando-permissao");
    await t.call("POST", `${t.path}/stop`);
    expect(t.engine.permissionReplies[0]).toMatchObject({ requestId: "per_1.1", reply: "reject" });
    expect((await t.statuses())["1.1"]).toBe("incompleta");
  });

  test("a second run in the same workspace is refused while one is in progress", async () => {
    const t = await setup({ "1.1": { hang: true } });
    await t.call("POST", `${t.path}/run`, { mode: "proxima" });
    const again = await t.call("POST", `${t.path}/run`, { mode: "proxima" });
    expect(again.status).toBe(409);
    expect(again.json.error.message).toContain("já está em andamento");
    await t.call("POST", `${t.path}/stop`);
  });

  test("after a restart, a task that was running is incomplete", () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
    const repo = new ApplyRepo(db);
    repo.save("w", "c", { taskId: "1.1", position: 1, status: "aguardando-permissao", before: {} });
    repo.interruptRunning();
    expect(repo.list("w", "c")[0]).toMatchObject({ status: "incompleta", error: "A aplicação foi reiniciada durante a task" });
  });
});

describe("4.2 aceitar, ajustar e desfazer", () => {
  test("Aceitar marks the task's own line, even after lines were added above it", async () => {
    const t = await setup();
    await t.runAndWait("todas");
    writeFileSync(t.tasksFile, TASKS.replace("## 1. Core\n", "## 1. Core\n\nNota adicionada depois.\n"));
    const s = (await t.call("POST", `${t.path}/tasks/1.2/accept`)).json as ApplyState;
    expect(readFileSync(t.tasksFile, "utf8")).toContain("- [ ] 1.1 Criar a\n- [x] 1.2 Criar b\n- [ ] 1.3 Criar c");
    expect(s.tasks[1]!.status).toBe("aceita");
    // The changes stay in the working tree, uncommitted.
    expect(existsSync(join(t.root, "t1.2.txt"))).toBe(true);
    expect(git(t.root, "log", "--oneline").trim().split("\n")).toHaveLength(1);
  });

  test("Ajustar re-prompts the apply session; the diff still starts before the task", async () => {
    const t = await setup();
    await t.runAndWait("proxima");
    const sessionId = t.engine.prompts[0]!.sessionId;
    expect((await t.call("POST", `${t.path}/tasks/1.1/adjust`, { request: "use loginError" })).status).toBe(202);
    await t.apply.settled(t.ws);
    expect(t.engine.prompts[1]).toMatchObject({ sessionId });
    expect(t.engine.prompts[1]!.text).toContain("> use loginError");
    const task = (await t.state()).tasks[0]!;
    expect(task.status).toBe("aguardando-revisao");
    expect(task.diff![0]!.files.map((f) => f.path)).toEqual(["ajuste-1.1.txt", "t1.1.txt"]);
  });

  test("Desfazer restores the files and makes the task pending; out of order is refused", async () => {
    const t = await setup({ "1.2": { write: { "src/main.ts": "alterado\n", "novo/b.ts": "b\n" } } });
    await t.runAndWait("todas");
    const early = await t.call("POST", `${t.path}/tasks/1.2/undo`);
    expect(early.status).toBe(409);
    expect(early.json.error.message).toContain("mais recente");
    expect((await t.state()).tasks.map((x) => x.canUndo ?? false)).toEqual([false, false, true]);

    await t.call("POST", `${t.path}/tasks/1.3/undo`);
    const s = (await t.call("POST", `${t.path}/tasks/1.2/undo`)).json as ApplyState;
    expect(s.tasks.map((x) => x.status)).toEqual(["aguardando-revisao", "pendente", "pendente"]);
    expect(readFileSync(join(t.root, "src/main.ts"), "utf8")).toBe("main\n");
    expect(existsSync(join(t.root, "novo"))).toBe(false);
    expect(existsSync(join(t.root, "t1.3.txt"))).toBe(false);
    expect(existsSync(join(t.root, "t1.1.txt"))).toBe(true);
  });

  test("an accepted task cannot be undone", async () => {
    const t = await setup();
    await t.runAndWait("proxima");
    await t.call("POST", `${t.path}/tasks/1.1/accept`);
    expect((await t.call("POST", `${t.path}/tasks/1.1/undo`)).status).toBe(409);
  });
});

describe("4.3 comandos permitidos", () => {
  test("detects test, lint, typecheck and build scripts by package manager", () => {
    const base = join(dir, "detect");
    const bun = folder(join(base, "bun"), { "package.json": '{"scripts":{"test":"t","lint":"l","dev":"d"}}', "bun.lock": "" }, { git: false });
    const npm = folder(join(base, "npm"), { "package.json": '{"scripts":{"build":"b"}}', "package-lock.json": "{}" }, { git: false });
    const pnpm = folder(join(base, "pnpm"), { "package.json": '{"scripts":{"typecheck":"tc"}}', "pnpm-lock.yaml": "" }, { git: false });
    const none = folder(join(base, "none"), { "README.md": "x" }, { git: false });
    expect(detectCommands([bun, npm, pnpm, none])).toEqual(["bun run test", "bun run lint", "npm run build", "pnpm run typecheck"]);
  });

  test("Lista inicial and editing: the list starts from the members and can be replaced", async () => {
    const t = await setup();
    expect((await t.call("GET", `/workspaces/${t.ws}/apply/commands`)).json).toEqual({ commands: ["npm run test", "npm run build"] });
    const put = await t.call("PUT", `/workspaces/${t.ws}/apply/commands`, { commands: [" bun  test ", "bun test", ""] });
    expect(put.json).toEqual({ commands: ["bun test"] });
  });

  test("Sempre neste workspace: the command joins the list and the next apply session's rules", async () => {
    const steps: Record<string, Step> = { "1.1": { ask: "bun run lint" } };
    const t = await setup(steps);
    await t.call("POST", `${t.path}/run`, { mode: "proxima" });
    await t.waitFor((s) => s.tasks[0]!.status === "aguardando-permissao");
    await t.call("POST", `${t.path}/permission`, { requestId: "per_1.1", reply: "always" });
    delete steps["1.1"]!.ask; // now allowed, so the engine would not ask again
    await t.apply.settled(t.ws);
    expect(t.engine.permissionReplies).toEqual([{ requestId: "per_1.1", reply: "once" }]);
    expect((await t.call("GET", `/workspaces/${t.ws}/apply/commands`)).json.commands).toContain("bun run lint");
    // A new apply session (another change here) gets the command in its rules.
    t.sessions.forget(t.ws, "c");
    await t.call("POST", `${t.path}/tasks/1.1/undo`);
    await t.runAndWait("proxima");
    const rules = t.engine.permissions.get(t.engine.prompts.at(-1)!.sessionId)!;
    expect(rules).toContainEqual({ permission: "bash", pattern: "bun run lint", action: "allow" });
  });
});

describe("4.4 endpoints", () => {
  test("invalid input and unknown tasks are refused", async () => {
    const t = await setup();
    expect((await t.call("POST", `${t.path}/run`, { mode: "algumas" })).status).toBe(400);
    expect((await t.call("POST", `${t.path}/tasks/1.1/accept`)).status).toBe(409);
    expect((await t.call("POST", `${t.path}/tasks/1.1/adjust`, { request: "" })).status).toBe(400);
    expect((await t.call("POST", `${t.path}/permission`, { requestId: "x", reply: "once" })).status).toBe(409);
    expect((await t.call("GET", `/workspaces/nada/changes/c/apply`)).status).toBe(404);
  });

  test("Change sem tasks: the state says so and running is refused", async () => {
    const t = await setup();
    rmSync(t.tasksFile);
    expect((await t.state()).hasTasks).toBe(false);
    const res = await t.call("POST", `${t.path}/run`, { mode: "proxima" });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toContain("tasks.md");
  });

  test("Multi-repo: one task writing in two members shows the diff grouped by member", async () => {
    const t = await setup({}, { multi: true });
    const [api, web] = t.members;
    // Steps are keyed by task id; this one writes in both members.
    t.engine.onPrompt = ((orig) => async (call, e) => {
      if (!call.text.startsWith("# Task 1.1")) return orig!(call, e);
      writeFileSync(join(api!, "src/auth.ts"), "auth 2\n");
      writeFileSync(join(web!, "src/msg.ts"), "msg\n");
      e.emit({ kind: "idle", sessionId: call.sessionId });
    })(t.engine.onPrompt);
    // The store was set up without Git, so the run asks for confirmation first.
    expect((await t.call("POST", `${t.path}/run`, { mode: "proxima" })).json.warnings).toEqual([{ member: "openspec", kind: "sem-git" }]);
    await t.runAndWait("proxima", true);
    const diff = (await t.state()).tasks[0]!.diff!;
    expect(diff.map((d) => [d.member, d.files.map((f) => [f.path, f.change])])).toEqual([
      ["repo-api", [["src/auth.ts", "modificado"]]],
      ["repo-web", [["src/msg.ts", "criado"]]],
    ]);
    const rules = t.engine.permissions.get(t.engine.prompts[0]!.sessionId)!;
    expect(rules).toContainEqual({ permission: "edit", pattern: `${api}/**`, action: "allow" });
    expect(rules).toContainEqual({ permission: "bash", pattern: "bun run test", action: "allow" });
  });
});

describe("5.3 aceitar e commitar", () => {
  const log = (repo: string) => git(repo, "log", "--format=%an|%s").trim().split("\n");
  const files = (repo: string) => git(repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean).sort();
  const accept = (t: Awaited<ReturnType<typeof setup>>, id: string, commit?: { message: string; noVerify?: boolean }) =>
    t.call("POST", `${t.path}/tasks/${id}/accept`, commit ? { commit } : undefined);

  test("Aceitar e commitar (mono-repo): one commit with the task's files and the marked tasks.md", async () => {
    const t = await setup();
    await t.runAndWait("proxima");
    expect((await t.state()).tasks[0]!.commit).toEqual({ allowed: true, message: "c: 1.1 Criar a", repos: ["app"], done: [] });
    const res = await accept(t, "1.1", { message: "c: 1.1 Criar a" });
    expect(res.status).toBe(200);
    expect(res.json.tasks[0].status).toBe("aceita");
    expect(log(t.root)[0]).toBe("Studio Teste|c: 1.1 Criar a");
    expect(files(t.root)).toEqual(["openspec/changes/c/tasks.md", "t1.1.txt"]);
    expect(git(t.root, "show", "HEAD:openspec/changes/c/tasks.md")).toContain("- [x] 1.1 Criar a");
    expect(git(t.root, "status", "--porcelain")).toBe("");
  });

  test("Aceitar (no commit) is as before: marked, files left uncommitted", async () => {
    const t = await setup();
    await t.runAndWait("proxima");
    expect((await accept(t, "1.1", { message: "  " })).status).toBe(400);
    expect((await accept(t, "1.1")).status).toBe(200);
    expect(log(t.root)).toHaveLength(1);
    expect(git(t.root, "status", "--porcelain")).toContain("t1.1.txt");
  });

  test("multi-repo with store: a commit in each member, and tasks.md in its own commit in the store", async () => {
    const t = await setup({ "1.1": { write: { "@0/src/auth.ts": "auth da task\n", "@1/src/novo.ts": "novo\n" } } }, { multi: true, storeGit: true });
    await t.runAndWait("proxima", true);
    expect((await t.state()).tasks[0]!.commit!.repos).toEqual(["repo-api", "repo-web", "openspec"]);
    expect((await accept(t, "1.1", { message: "c: 1.1 Criar a" })).status).toBe(200);
    expect(files(t.members[0]!)).toEqual(["src/auth.ts"]);
    expect(files(t.members[1]!)).toEqual(["src/novo.ts"]);
    expect(files(t.root)).toEqual(["openspec/changes/c/tasks.md"]);
    for (const repo of [...t.members, t.root]) expect(git(repo, "status", "--porcelain")).toBe("");
  });

  test("Falha no commit: not accepted, the commits made are kept and listed, and a retry does not commit twice", async () => {
    const t = await setup({ "1.1": { write: { "@0/src/auth.ts": "auth da task\n", "@1/src/novo.ts": "novo\n" } } }, { multi: true, storeGit: true });
    await t.runAndWait("proxima", true);
    const hook = join(t.members[1]!, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint falhou' >&2\nexit 1\n", { mode: 0o755 });
    const tasksBefore = readFileSync(t.tasksFile, "utf8");

    const failed = await accept(t, "1.1", { message: "m" });
    expect(failed.status).toBe(422);
    expect(failed.json.error).toMatchObject({ code: "git_failed", kind: "hook", output: expect.stringContaining("lint falhou") });
    const task = (await t.state()).tasks[0]!;
    expect(task.status).toBe("aguardando-revisao");
    expect(task.commit!.done).toEqual(["repo-api"]);
    expect(readFileSync(t.tasksFile, "utf8")).toBe(tasksBefore);
    expect(log(t.members[0]!)).toHaveLength(2);
    expect(log(t.root)).toHaveLength(1);

    // "Commitar sem hooks": the members already committed are skipped.
    expect((await accept(t, "1.1", { message: "m", noVerify: true })).status).toBe(200);
    expect(log(t.members[0]!)).toHaveLength(2);
    expect(log(t.members[1]!)).toHaveLength(2);
    expect(files(t.root)).toEqual(["openspec/changes/c/tasks.md"]);
  });

  test("Commitar fora de ordem: only after the earlier task is accepted", async () => {
    const t = await setup();
    await t.runAndWait("todas");
    const before = await t.state();
    expect(before.tasks[1]!.commit).toMatchObject({ allowed: false, reason: expect.stringContaining("tasks anteriores") });
    expect((await accept(t, "1.2", { message: "m" })).status).toBe(409);
    expect((await accept(t, "1.1", { message: "m1" })).status).toBe(200);
    expect((await t.state()).tasks[1]!.commit!.allowed).toBe(true);
    expect((await accept(t, "1.2", { message: "m2" })).status).toBe(200);
    expect(files(t.root)).toEqual(["openspec/changes/c/tasks.md", "t1.2.txt"]);
  });

  test("Arquivo já alterado antes da task: flagged, the commit is refused, plain accept still works", async () => {
    const t = await setup({ "1.1": { write: { "src/main.ts": "main da task\n" } } }, { dirty: true });
    await t.runAndWait("proxima", true);
    const task = (await t.state()).tasks[0]!;
    expect(task.diff![0]!.dirtyBefore).toEqual(["src/main.ts"]);
    expect(task.commit).toMatchObject({ allowed: false, reason: expect.stringContaining("já tinham alterações") });
    expect((await accept(t, "1.1", { message: "m" })).status).toBe(409);
    expect((await accept(t, "1.1")).status).toBe(200);
  });

  test("Conteúdo exato da task: a later edit by the user stays out of the commit", async () => {
    const t = await setup({ "1.1": { write: { "src/main.ts": "main da task\n" } } });
    await t.runAndWait("proxima");
    writeFileSync(join(t.root, "src/main.ts"), "editado depois\n");
    expect((await accept(t, "1.1", { message: "m" })).status).toBe(200);
    expect(git(t.root, "show", "HEAD:src/main.ts")).toBe("main da task\n");
    expect(git(t.root, "status", "--porcelain").trim()).toBe("M src/main.ts");
  });

  test("a workspace outside Git offers no commit", async () => {
    const t = await setup({}, { git: false });
    await t.runAndWait("proxima", true);
    expect((await t.state()).tasks[0]!.commit).toBeUndefined();
    expect((await accept(t, "1.1", { message: "m" })).status).toBe(409);
  });
});
