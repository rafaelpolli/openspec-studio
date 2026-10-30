import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Workspace } from "../packages/shared/src/index.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandList } from "../packages/server/src/apply/commands.ts";
import { containerEngineFactory, EngineRegistry } from "../packages/server/src/apply/engines.ts";
import { EnvironmentStore } from "../packages/server/src/apply/environment.ts";
import { EnvironmentManager, processRunner } from "../packages/server/src/apply/environments.ts";
import { ApplyRepo } from "../packages/server/src/apply/repo.ts";
import { ApplyService } from "../packages/server/src/apply/service.ts";
import { openDatabase } from "../packages/server/src/db.ts";
import { AgentRunner } from "../packages/server/src/engine/runner.ts";
import { ChangeSessions } from "../packages/server/src/engine/sessions.ts";
import { EventBus } from "../packages/server/src/events.ts";
import { OpenSpecAdapter } from "../packages/server/src/openspec/adapter.ts";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { FakeEngine } from "../packages/server/src/testing/fake-engine.ts";
import { startMockLlm, type MockLlm, type ToolCall } from "../packages/server/src/testing/mock-llm.ts";
import { WorkspaceRepo } from "../packages/server/src/workspaces/repo.ts";
import { WorkspaceService } from "../packages/server/src/workspaces/service.ts";
import { WorkspaceWatcher } from "../packages/server/src/workspaces/watcher.ts";

// add-apply-devcontainer 5.1: two workspaces, each with its own container (Node 20 and Node 22),
// applied at the same time by the real backend services and the embedded engine inside each
// container, driven by the simulated LLM. Needs Docker, Node and the two typescript-node images.
const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
const hasDocker = run(["docker", "info"]).exitCode === 0;
const hasNode = run(["node", "--version"]).exitCode === 0;
const gateway = hasDocker ? run(["docker", "network", "inspect", "bridge", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"]).stdout.toString().trim() : "";

const base = mkdtempSync(join(tmpdir(), "studio-e2e-container-"));
const xdg = join(base, ".xdg");
const cli = new OpenSpecCli({ env: { XDG_DATA_HOME: xdg } });
let llm: MockLlm;
let apply: ApplyService;
let registry: EngineRegistry;
let store: EnvironmentStore;
let manager: EnvironmentManager;
let wsA: Workspace;
let wsB: Workspace;
const watcher = new WorkspaceWatcher(new EventBus());

const TASKS = "## 1. Ambiente\n\n- [ ] 1.1 Registrar o ambiente\n";
// No ">" anywhere: a redirection (or an arrow function) would make the engine ask for permission.
const VERSION = `node -e "require('fs').writeFileSync('versao.txt', process.version)"`;
const PORT = `node -e "var fs=require('fs'); var s=require('http').createServer(); s.on('error', function(e){ fs.writeFileSync('porta.txt', e.code) }); s.listen(3000, function(){ fs.writeFileSync('porta.txt', 'ok'); setTimeout(function(){ s.close() }, 12000) })"`;
const GLOBAL = "npm i -g ./marcador --no-audit --no-fund";

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe" }).stdout.toString();
}

async function project(name: string, files: Record<string, string>): Promise<string> {
  const root = join(base, name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), content);
    if (file.includes("/bin/")) chmodSync(join(root, file), 0o755);
  }
  await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
  await cli.run(["new", "change", "c"], { cwd: root });
  writeFileSync(join(root, "openspec/changes/c/tasks.md"), TASKS);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "inicial");
  return root;
}

describe.skipIf(!hasDocker || !hasNode || !gateway)("5.1 apply em containers isolados (Docker + LLM simulado)", () => {
  beforeAll(async () => {
    const pkg = { "marcador/package.json": '{"name":"marcador","version":"1.0.0","bin":{"marcador":"bin/m.js"}}', "marcador/bin/m.js": "#!/usr/bin/env node\nconsole.log('marcado')\n" };
    const a = await project("app-node20", {
      ...pkg,
      ".devcontainer/devcontainer.json": '{ "image": "mcr.microsoft.com/devcontainers/typescript-node:20", "remoteUser": "node", "updateRemoteUserUID": true }\n',
    });
    const b = await project("app-node22", { "src/main.ts": "x\n" });

    llm = startMockLlm(
      [],
      (prompt): ToolCall[] => {
        const root = /^- [\w.-]+: `([^`]+)`/m.exec(prompt)?.[1] ?? "/missing";
        const bash = (command: string) => ({ tool: "bash", args: { command, description: "cmd", workdir: root } });
        return [
          bash(VERSION),
          bash(PORT),
          ...(root.endsWith("app-node20") ? [bash(GLOBAL)] : []),
          { tool: "write", args: { filePath: join(root, "src", "feito.ts"), content: "feito\n" } },
        ];
      },
      gateway,
    );

    const db = openDatabase(":memory:");
    const adapter = new OpenSpecAdapter(cli);
    const workspaces = new WorkspaceService(new WorkspaceRepo(db), adapter, watcher);
    wsA = (await workspaces.register({ kind: "mono", path: a })).workspace;
    wsB = (await workspaces.register({ kind: "mono", path: b })).workspace;
    store = new EnvironmentStore(db);
    store.set(wsA, { mode: `devcontainer:${join(a, ".devcontainer", "devcontainer.json")}`, idleMinutes: 30 });
    store.set(wsB, { mode: "imagem:node", idleMinutes: 30 });
    const events = new EventBus();
    const dataDir = join(base, "environments");
    manager = new EnvironmentManager(store, events, { dataDir, cliPath: Bun.resolveSync("@devcontainers/cli/devcontainer.js", join(import.meta.dir, "../packages/server/src")) });
    const local = new FakeEngine(); // must never be used: both workspaces run in containers
    local.onPrompt = () => {
      throw new Error("a task foi para o motor local");
    };
    registry = new EngineRegistry(
      new AgentRunner(local, new ChangeSessions(db, local), events),
      store,
      manager,
      db,
      events,
      containerEngineFactory({
        manager,
        authFile: join(base, "sem-auth.json"),
        version: "1.19.4",
        cacheDir: join(dataDir, "binaries"),
        config: () => ({ provider: llm.providerConfig, model: "mock/m" }),
      }),
    );
    const commands = new CommandList(db);
    for (const ws of [wsA, wsB]) commands.set(ws.id, ["node", "npm"]);
    apply = new ApplyService(workspaces, adapter, registry, new ApplyRepo(db), commands);
  }, 120_000);

  afterAll(async () => {
    await registry?.stopAll();
    await llm?.stop();
    watcher.close();
    for (const ws of [wsA, wsB].filter(Boolean)) {
      const ids = (await processRunner.run(["docker", "ps", "-aq", "--filter", `label=studio.workspace=${ws.id}`])).stdout.trim().split("\n").filter(Boolean);
      if (ids.length) await processRunner.run(["docker", "rm", "-f", ...ids]);
    }
    const keep = process.env.STUDIO_E2E_KEEP_LOGS;
    if (keep) Bun.spawnSync(["sh", "-c", `mkdir -p '${keep}' && cp ${join(base, "environments")}/*/engine/engine.log '${keep}'/ 2>/dev/null; for f in ${join(base, "environments")}/*/engine/engine.log; do cp "$f" "${keep}/$(basename $(dirname $(dirname "$f"))).log"; done`]);
    rmSync(base, { recursive: true, force: true });
  });

  test("the two tasks run at the same time, each in its own Node, both holding port 3000", async () => {
    // Prepare both containers and engines first, so the two tasks then run at the same time.
    // (Inside the test: bun test kills child processes still running when a hook ends.)
    await Promise.all([registry.ready(wsA), registry.ready(wsB)]);
    await Promise.all([apply.run(wsA.id, "c", "proxima", false), apply.run(wsB.id, "c", "proxima", false)]);
    await Promise.all([apply.settled(wsA.id), apply.settled(wsB.id)]);
    for (const ws of [wsA, wsB]) {
      const task = (await apply.state(ws.id, "c")).tasks[0]!;
      expect({ ws: ws.name, status: task.status, error: task.error }).toEqual({ ws: ws.name, status: "aguardando-revisao", error: undefined });
    }
    expect(readFileSync(join(wsA.rootPath, "versao.txt"), "utf8")).toStartWith("v20.");
    expect(readFileSync(join(wsB.rootPath, "versao.txt"), "utf8")).toStartWith("v22.");
    // Each container has its own network: neither got EADDRINUSE.
    expect(readFileSync(join(wsA.rootPath, "porta.txt"), "utf8")).toBe("ok");
    expect(readFileSync(join(wsB.rootPath, "porta.txt"), "utf8")).toBe("ok");
  }, 900_000);

  test("a global npm install in one workspace is visible neither in the other nor on the machine", async () => {
    const container = async (ws: Workspace) =>
      (await processRunner.run(["docker", "ps", "-q", "--filter", `label=studio.workspace=${ws.id}`])).stdout.trim();
    const inA = await processRunner.run(["docker", "exec", "-u", "node", await container(wsA), "npm", "ls", "-g", "marcador"]);
    const inB = await processRunner.run(["docker", "exec", "-u", "node", await container(wsB), "npm", "ls", "-g", "marcador"]);
    expect(inA.stdout).toContain("marcador@1.0.0");
    expect(inB.stdout).not.toContain("marcador");
    expect(run(["sh", "-c", "command -v marcador"]).exitCode).not.toBe(0);
  });

  test("the files belong to the user, and the diff and undo work as in the local apply", async () => {
    const feito = join(wsA.rootPath, "src", "feito.ts");
    expect(statSync(feito).uid).toBe(process.getuid!());
    const task = (await apply.state(wsA.id, "c")).tasks[0]!;
    expect(task.diff![0]!.files.map((f) => [f.path, f.change])).toEqual([
      ["porta.txt", "criado"],
      ["src/feito.ts", "criado"],
      ["versao.txt", "criado"],
    ]);
    await apply.undo(wsA.id, "c", "1.1");
    expect(existsSync(feito)).toBe(false);
    expect(existsSync(join(wsA.rootPath, "versao.txt"))).toBe(false);
    expect(git(wsA.rootPath, "status", "--porcelain")).toBe("");
    expect((await apply.state(wsA.id, "c")).tasks[0]!.status).toBe("pendente");
  });
});
