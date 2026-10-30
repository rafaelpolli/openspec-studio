import { afterAll, describe, expect, test } from "bun:test";
import type { Workspace } from "@studio/shared";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events.ts";
import { EnvironmentStore } from "./environment.ts";
import { EnvironmentError, EnvironmentManager, processRunner, type CommandRunner } from "./environments.ts";

const base = mkdtempSync(join(tmpdir(), "studio-envs-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
function workspace(opts: { devcontainer?: boolean; members?: string[] } = {}): Workspace {
  const root = join(base, `ws-${++counter}`);
  mkdirSync(join(root, ".devcontainer"), { recursive: true });
  if (opts.devcontainer) writeFileSync(join(root, ".devcontainer", "devcontainer.json"), '{ "image": "x" }\n');
  const members = opts.members ?? [root];
  return {
    id: `w${counter}`,
    name: `ws-${counter}`,
    kind: members.length > 1 ? "multi" : "mono",
    rootPath: root,
    storeId: null,
    members: members.map((p, i) => ({ name: `m${i}`, path: p })),
    createdAt: "now",
  };
}

/** A scripted docker/devcontainer CLI: answers by the command's first words and records every call. */
function fakeRunner(overrides: Record<string, { exitCode?: number; stdout?: string; stderr?: string; lines?: string[] }> = {}) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(cmd, opts = {}) {
      calls.push(cmd);
      const key = cmd[0] === "node" && cmd[2] === "up" ? "up" : cmd.slice(0, 2).join(" ");
      const defaults: Record<string, { stdout?: string; lines?: string[] }> = {
        "docker info": { stdout: "29.9.2\n" },
        "node --version": { stdout: "v22.22.1\n" },
        up: { lines: ["[1] Start: Run: docker build", "[2] Container started"], stdout: '{"outcome":"success","containerId":"c0ffee","remoteUser":"vscode"}\n' },
        "docker exec": { stdout: `${process.getuid!()}\n` },
        "docker stop": { stdout: "c0ffee\n" },
        "docker ps": { stdout: "c0ffee\n" },
      };
      const r = { ...defaults[key], ...overrides[key] };
      for (const line of r.lines ?? []) opts.onLine?.(line);
      return { exitCode: overrides[key]?.exitCode ?? 0, stdout: r.stdout ?? "", stderr: overrides[key]?.stderr ?? "" };
    },
  };
  return { runner, calls };
}

function setup(runner: CommandRunner, now = { t: 0 }) {
  const db = openDatabase(":memory:");
  const store = new EnvironmentStore(db);
  const events = new EventBus();
  const seen: string[] = [];
  events.subscribe((e) => e.type === "environment-changed" && seen.push(e.workspaceId));
  const manager = new EnvironmentManager(store, events, { dataDir: join(base, "data"), cliPath: "/cli/devcontainer.js", runner, now: () => now.t });
  return { store, manager, seen, now };
}

describe("2.2 gerenciador de ambientes (CLI falsa)", () => {
  test("Primeira execução: prepares with the project's devcontainer, mounts at the same paths, streams the output", async () => {
    const { runner, calls } = fakeRunner();
    const { store, manager, seen } = setup(runner);
    const api = join(base, "api-x");
    const ws = workspace({ devcontainer: true, members: [join(base, "api-x"), join(base, "web-x")] });
    mkdirSync(api, { recursive: true });
    const config = join(ws.rootPath, ".devcontainer", "devcontainer.json");
    store.set({ ...ws, members: [{ name: "root", path: ws.rootPath }, ...ws.members] }, { mode: `devcontainer:${config}`, idleMinutes: 30 });

    expect(manager.status(ws).state).toBe("ausente");
    const ready = await manager.ensure(ws);
    expect(ready).toEqual({ containerId: "c0ffee", remoteUser: "vscode", engineDir: manager.engineDir(ws.id) });
    const up = calls.find((c) => c[2] === "up")!;
    expect(up.slice(0, 2)).toEqual(["node", "/cli/devcontainer.js"]);
    expect(up).toContain("--config");
    expect(up[up.indexOf("--config") + 1]).toBe(config);
    expect(up[up.indexOf("--workspace-folder") + 1]).toBe(ws.rootPath);
    expect(up[up.indexOf("--id-label") + 1]).toBe(`studio.workspace=${ws.id}`);
    for (const p of [ws.rootPath, ...ws.members.map((m) => m.path), manager.engineDir(ws.id)]) {
      expect(up).toContain(`type=bind,source=${p},target=${p}`);
    }
    const status = manager.status(ws);
    expect(status).toMatchObject({ state: "pronto", output: ["[1] Start: Run: docker build", "[2] Container started"] });
    expect(status.uidMismatch).toBeUndefined();
    expect(seen.length).toBeGreaterThan(2);
  });

  test("Reaproveitar: a ready container is reused without preparing again", async () => {
    const { runner, calls } = fakeRunner();
    const { store, manager } = setup(runner);
    const ws = workspace();
    store.set(ws, { mode: "imagem:node", idleMinutes: 30 });
    await manager.ensure(ws);
    await manager.ensure(ws);
    expect(calls.filter((c) => c[2] === "up")).toHaveLength(1);
  });

  test("stock images get a generated devcontainer.json in the app's data, never in the repo", async () => {
    const { runner, calls } = fakeRunner();
    const { store, manager } = setup(runner);
    const ws = workspace();
    store.set(ws, { mode: "imagem:node", idleMinutes: 30 });
    await manager.ensure(ws);
    const up = calls.find((c) => c[2] === "up")!;
    const config = up[up.indexOf("--config") + 1]!;
    expect(config.startsWith(join(base, "data"))).toBe(true);
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject({
      image: "mcr.microsoft.com/devcontainers/typescript-node:22",
      updateRemoteUserUID: true,
    });
  });

  test("ociosidade: an idle container is stopped; a used one is not", async () => {
    const { runner, calls } = fakeRunner();
    const now = { t: 0 };
    const { store, manager } = setup(runner, now);
    const ws = workspace();
    store.set(ws, { mode: "imagem:base", idleMinutes: 10 });
    await manager.ensure(ws);
    now.t = 9 * 60_000;
    await manager.sweepIdle();
    expect(manager.status(ws).state).toBe("pronto");
    manager.touch(ws.id);
    now.t = 18 * 60_000;
    await manager.sweepIdle();
    expect(manager.status(ws).state).toBe("pronto");
    now.t = 30 * 60_000;
    await manager.sweepIdle();
    expect(manager.status(ws).state).toBe("parado");
    expect(calls.at(-1)).toEqual(["docker", "stop", "c0ffee"]);
  });

  test("Reconstruir: recreates the container, and a changed devcontainer.json suggests it", async () => {
    const { runner, calls } = fakeRunner();
    const { store, manager } = setup(runner);
    const ws = workspace({ devcontainer: true });
    const config = join(ws.rootPath, ".devcontainer", "devcontainer.json");
    store.set(ws, { mode: `devcontainer:${config}`, idleMinutes: 30 });
    await manager.ensure(ws);
    expect(manager.status(ws).needsRebuild).toBeUndefined();
    writeFileSync(config, '{ "image": "y" }\n');
    expect(manager.status(ws).needsRebuild).toBe(true);
    await manager.rebuild(ws);
    expect(calls.filter((c) => c[2] === "up").at(-1)).toContain("--remove-existing-container");
    expect(manager.status(ws).needsRebuild).toBeUndefined();
  });

  test("after a restart, the container is found by its label and counts as stopped", async () => {
    const { runner, calls } = fakeRunner();
    const { store, manager } = setup(runner);
    const ws = workspace();
    const local = workspace();
    store.set(ws, { mode: "imagem:base", idleMinutes: 30 });
    await manager.recover([ws, local]);
    expect(calls).toEqual([["docker", "ps", "-a", "--filter", `label=studio.workspace=${ws.id}`, "--format", "{{.ID}}"]]);
    expect(manager.status(ws).state).toBe("parado");
    expect(manager.status(local).state).toBe("ausente");
  });

  test("Docker ausente, Node ausente and a failed build stop with a clear error", async () => {
    const cases: [Parameters<typeof fakeRunner>[0], string][] = [
      [{ "docker info": { exitCode: 1, stderr: "permission denied while trying to connect" } }, "o Docker não está acessível nesta máquina (permission denied"],
      [{ "node --version": { exitCode: 127, stdout: "" } }, "precisa do Node 18"],
      [{ "node --version": { stdout: "v16.20.0\n" } }, "precisa do Node 18"],
      [{ up: { exitCode: 1, stdout: '{"outcome":"error","message":"build failed: npm ERR!"}\n' } }, "o preparo do container falhou: build failed: npm ERR!"],
    ];
    for (const [overrides, message] of cases) {
      const { runner } = fakeRunner(overrides);
      const { store, manager } = setup(runner);
      const ws = workspace();
      store.set(ws, { mode: "imagem:base", idleMinutes: 30 });
      const err = await manager.ensure(ws).catch((e: Error) => e);
      expect(err).toBeInstanceOf(EnvironmentError);
      expect((err as Error).message).toContain(message);
      expect(manager.status(ws)).toMatchObject({ state: "falhou", error: expect.stringContaining(message) });
    }
  });

  test("a member path inside a system folder of the image is refused", async () => {
    const { runner, calls } = fakeRunner();
    const { store, manager } = setup(runner);
    const ws = workspace();
    store.set(ws, { mode: "imagem:base", idleMinutes: 30 });
    const clash = { ...ws, members: [...ws.members, { name: "legado", path: "/usr/src/app" }] };
    const err = await manager.ensure(clash).catch((e: Error) => e);
    expect((err as Error).message).toContain("/usr/src/app cai em /usr");
    expect(calls.some((c) => c[2] === "up")).toBe(false);
  });

  test("a container user without the machine's UID is flagged", async () => {
    const { runner } = fakeRunner({ "docker exec": { stdout: "1234\n" } });
    const { store, manager } = setup(runner);
    const ws = workspace();
    store.set(ws, { mode: "imagem:base", idleMinutes: 30 });
    await manager.ensure(ws);
    expect(manager.status(ws).uidMismatch).toBe(true);
  });
});

describe("2.2 exec no ambiente do apply (add-change-verification)", () => {
  test("Ambiente em container: docker exec as the remote user, in the folder, with the limit applied inside", async () => {
    const { runner, calls } = fakeRunner();
    const { store, manager, now } = setup(runner);
    const ws = workspace();
    store.set(ws, { mode: "imagem:base", idleMinutes: 1 });
    await manager.ensure(ws);
    now.t = 50_000;
    calls.length = 0;
    const res = await manager.exec(ws, ["bun", "test", "./a.test.ts", "-t", "x"], { cwd: ws.rootPath, timeoutMs: 90_000 });
    expect(calls).toEqual([
      ["docker", "exec", "-u", "vscode", "-w", ws.rootPath, "c0ffee", "timeout", "-s", "KILL", "90", "bun", "test", "./a.test.ts", "-t", "x"],
    ]);
    expect(res).toEqual({ exitCode: 0, output: `${process.getuid!()}`, timedOut: false });
    // The run counts as use: the container is not idle-stopped right after it.
    now.t = 100_000;
    await manager.sweepIdle();
    expect(manager.status(ws).state).toBe("pronto");
  });

  test("a command killed by the limit inside the container counts as timed out", async () => {
    const { runner } = fakeRunner({ "docker exec": { exitCode: 137 } });
    const { store, manager } = setup(runner);
    const ws = workspace();
    store.set(ws, { mode: "imagem:base", idleMinutes: 30 });
    await manager.ensure(ws).catch(() => {}); // uid check also answers 137 here; the container is still ready
    const res = await manager.exec(ws, ["sleep", "9"], { cwd: ws.rootPath, timeoutMs: 1000 });
    expect(res.timedOut).toBe(true);
  });

  test("Modo local: runs on the machine in the folder, output joined and limited to the last 200 lines", async () => {
    const { store, manager } = setup(processRunner);
    const ws = workspace();
    store.set(ws, { mode: "local", idleMinutes: 30 });
    const script = "for i in $(seq 1 250); do echo out$i; done; echo erro >&2; pwd; exit 3";
    const res = await manager.exec(ws, ["sh", "-c", script], { cwd: ws.rootPath, timeoutMs: 10_000 });
    expect(res.exitCode).toBe(3);
    const lines = res.output.split("\n");
    expect(lines).toHaveLength(200);
    expect(lines.at(-2)).toBe(ws.rootPath);
    expect(lines.at(-1)).toBe("erro");
    const slow = await manager.exec(ws, ["sleep", "5"], { cwd: ws.rootPath, timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
  });
});

// The real CLI and Docker; skipped where either is missing.
const hasDocker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const hasNode = Bun.spawnSync(["node", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe.skipIf(!hasDocker || !hasNode)("2.2 integração com Docker", () => {
  test("prepares the base image for real, reuses it, stops it and finds it again", async () => {
    const db = openDatabase(":memory:");
    const store = new EnvironmentStore(db);
    const opts = { dataDir: join(base, "real"), cliPath: Bun.resolveSync("@devcontainers/cli/devcontainer.js", import.meta.dir) };
    const manager = new EnvironmentManager(store, new EventBus(), opts);
    const ws = workspace();
    writeFileSync(join(ws.rootPath, "a.txt"), "a\n");
    store.set(ws, { mode: "imagem:base", idleMinutes: 30 });
    try {
      const ready = await manager.ensure(ws);
      expect(manager.status(ws).state).toBe("pronto");
      const seen = await processRunner.run(["docker", "exec", "-u", ready.remoteUser, ready.containerId, "cat", join(ws.rootPath, "a.txt")]);
      expect(seen.stdout).toBe("a\n");
      expect((await manager.ensure(ws)).containerId).toBe(ready.containerId);
      await manager.stop(ws);
      expect(manager.status(ws).state).toBe("parado");
      const restarted = new EnvironmentManager(store, new EventBus(), opts);
      await restarted.recover([ws]);
      expect(restarted.status(ws).state).toBe("parado");
    } finally {
      const ids = (await processRunner.run(["docker", "ps", "-aq", "--filter", `label=studio.workspace=${ws.id}`])).stdout.trim().split("\n").filter(Boolean);
      if (ids.length) await processRunner.run(["docker", "rm", "-f", ...ids]);
    }
  }, 300_000);
});
