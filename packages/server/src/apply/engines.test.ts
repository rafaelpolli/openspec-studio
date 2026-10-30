import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { AgentRunner } from "../engine/runner.ts";
import { ChangeSessions } from "../engine/sessions.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { FakeEngine } from "../testing/fake-engine.ts";
import { sandbox } from "../testing/fixture.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import { CommandList } from "./commands.ts";
import { EngineRegistry } from "./engines.ts";
import { EnvironmentStore } from "./environment.ts";
import { EnvironmentManager, type CommandRunner } from "./environments.ts";
import { ApplyRepo } from "./repo.ts";
import { ApplyService } from "./service.ts";

setDefaultTimeout(60_000);

const { dir, cli } = sandbox("studio-engines-");
const adapter = new OpenSpecAdapter(cli);
const watcher = new WorkspaceWatcher(new EventBus());
afterAll(() => {
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An engine whose every prompt finishes at once. */
function finishing(): FakeEngine {
  const engine = new FakeEngine();
  engine.onPrompt = (call, e) => void Promise.resolve().then(() => e.emit({ kind: "idle", sessionId: call.sessionId }));
  return engine;
}

function runnerFor(opts: { dockerOk?: boolean }): CommandRunner {
  return {
    async run(cmd) {
      if (cmd[1] === "info") return { exitCode: opts.dockerOk === false ? 1 : 0, stdout: "29\n", stderr: opts.dockerOk === false ? "Cannot connect to the Docker daemon" : "" };
      if (cmd[0] === "node" && cmd[1] === "--version") return { exitCode: 0, stdout: "v22.0.0\n", stderr: "" };
      if (cmd[2] === "up") return { exitCode: 0, stdout: '{"outcome":"success","containerId":"c1","remoteUser":"vscode"}\n', stderr: "" };
      return { exitCode: 0, stdout: `${process.getuid!()}\n`, stderr: "" };
    },
  };
}

let counter = 0;
async function setup(opts: { dockerOk?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), adapter, watcher);
  const events = new EventBus();
  const local = finishing();
  const container = finishing();
  const store = new EnvironmentStore(db);
  const manager = new EnvironmentManager(store, events, { dataDir: join(dir, `data-${++counter}`), cliPath: "/cli.js", runner: runnerFor(opts) });
  const made: string[] = [];
  const registry = new EngineRegistry(new AgentRunner(local, new ChangeSessions(db, local), events), store, manager, db, events, (ws) => {
    made.push(ws.id);
    return container;
  });
  const apply = new ApplyService(workspaces, adapter, registry, new ApplyRepo(db), new CommandList(db));
  const register = async (name: string) => {
    const root = join(dir, `${name}-${counter}`);
    mkdirSync(root, { recursive: true });
    await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
    await cli.run(["new", "change", "c"], { cwd: root });
    writeFileSync(join(root, "openspec/changes/c/tasks.md"), "## 1. A\n\n- [ ] 1.1 Fazer\n");
    return (await workspaces.register({ kind: "mono", path: root })).workspace;
  };
  return { apply, store, manager, local, container, made, register, workspaces };
}

describe("3.2 registro de motores", () => {
  test("a workspace in a container runs its tasks on its own engine; a local one on the machine's", async () => {
    const t = await setup();
    const boxed = await t.register("boxed");
    const plain = await t.register("plain");
    t.store.set(boxed, { mode: "imagem:node", idleMinutes: 30 });

    await t.apply.run(boxed.id, "c", "proxima", true);
    await t.apply.settled(boxed.id);
    await t.apply.run(plain.id, "c", "proxima", true);
    await t.apply.settled(plain.id);

    expect(t.container.prompts.map((p) => p.opts.directory)).toEqual([boxed.rootPath]);
    expect(t.local.prompts.map((p) => p.opts.directory)).toEqual([plain.rootPath]);
    expect(t.made).toEqual([boxed.id]);
    expect((await t.apply.state(boxed.id, "c")).tasks[0]!.status).toBe("aguardando-revisao");
    expect((await t.apply.state(plain.id, "c")).tasks[0]!.status).toBe("aguardando-revisao");
  });

  test("Falha do ambiente: the task does not start, and nothing falls back to the local engine", async () => {
    const t = await setup({ dockerOk: false });
    const boxed = await t.register("broken");
    t.store.set(boxed, { mode: "imagem:base", idleMinutes: 30 });
    await t.apply.run(boxed.id, "c", "proxima", true);
    await t.apply.settled(boxed.id);
    expect(t.local.prompts).toHaveLength(0);
    expect(t.container.prompts).toHaveLength(0);
    expect((await t.apply.state(boxed.id, "c")).tasks[0]!.status).toBe("pendente");
    expect(t.manager.status(boxed)).toMatchObject({ state: "falhou", error: expect.stringContaining("Docker não está acessível") });
  });

  test("stopping the container stops its engine first, and going back to local uses the machine's engine", async () => {
    const t = await setup();
    const boxed = await t.register("switch");
    t.store.set(boxed, { mode: "imagem:base", idleMinutes: 30 });
    await t.apply.run(boxed.id, "c", "proxima", true);
    await t.apply.settled(boxed.id);
    await t.manager.stop(boxed);
    expect(t.container.state).toBe("stopped");

    t.store.set(boxed, { mode: "local", idleMinutes: 30 });
    await t.apply.undo(boxed.id, "c", "1.1");
    await t.apply.run(boxed.id, "c", "proxima", true);
    await t.apply.settled(boxed.id);
    expect(t.local.prompts.map((p) => p.opts.directory)).toEqual([boxed.rootPath]);
  });
});
