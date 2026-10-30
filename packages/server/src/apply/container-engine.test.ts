import { afterAll, describe, expect, test } from "bun:test";
import type { Workspace } from "@studio/shared";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import type { EngineEvent } from "../engine/engine.ts";
import { applyPermissions } from "../engine/guard.ts";
import { OpencodeEngine } from "../engine/opencode.ts";
import { engineEnv } from "../engine/process.ts";
import { EventBus } from "../events.ts";
import { startMockLlm } from "../testing/mock-llm.ts";
import { binaryFor, CONTAINER_BINARY, ContainerLauncher } from "./container-engine.ts";
import { EnvironmentStore } from "./environment.ts";
import { EnvironmentManager, processRunner, type CommandRunner } from "./environments.ts";

const base = mkdtempSync(join(tmpdir(), "studio-cengine-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
function workspace(): Workspace {
  const root = join(base, `ws-${++counter}`);
  mkdirSync(join(root, "openspec", "changes", "c"), { recursive: true });
  writeFileSync(join(root, "openspec", "changes", "c", "tasks.md"), "- [ ] 1.1 x\n");
  return { id: `w${counter}`, name: `ws-${counter}`, kind: "mono", rootPath: root, storeId: null, members: [{ name: "app", path: root }], createdAt: "now" };
}

describe("3.1 binário do motor por variante", () => {
  test("the machine's variant comes from node_modules; a missing one is downloaded once, even when asked twice at once", async () => {
    expect(await binaryFor("opencode-linux-x64", "1.19.4", join(base, "cache"))).toContain("node_modules");
    const pkg = join(base, "pkg");
    mkdirSync(join(pkg, "package", "bin"), { recursive: true });
    writeFileSync(join(pkg, "package", "bin", "opencode"), "#!/bin/sh\n");
    const tgz = join(base, "fake.tgz");
    Bun.spawnSync(["tar", "czf", tgz, "-C", pkg, "package"]);
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => (urls.push(String(url)), new Response(readFileSync(tgz)))) as typeof fetch;
    try {
      const [a, b] = await Promise.all([
        binaryFor("opencode-linux-arm64-musl", "1.19.4", join(base, "cache")),
        binaryFor("opencode-linux-arm64-musl", "1.19.4", join(base, "cache")),
      ]);
      expect(a).toBe(b);
      expect(readFileSync(a, "utf8")).toBe("#!/bin/sh\n");
      expect(urls).toEqual(["https://registry.npmjs.org/opencode-linux-arm64-musl/-/opencode-linux-arm64-musl-1.19.4.tgz"]);
      // Cached afterwards: no new download.
      await binaryFor("opencode-linux-arm64-musl", "1.19.4", join(base, "cache"));
      expect(urls).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("3.1 motor no container (runner falso)", () => {
  test("copies the right binary in as root, passes the environment by file and copies the credentials", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(cmd) {
        calls.push(cmd);
        const out = cmd[2] === "up" ? '{"outcome":"success","containerId":"c1","remoteUser":"vscode"}' : cmd.includes("uname -m; ls /lib/ld-musl-* >/dev/null 2>&1 && echo musl || echo glibc") ? "x86_64\nmusl" : cmd[1] === "inspect" ? "172.17.0.9" : cmd[1] === "info" ? "29" : cmd[0] === "node" ? "v22.0.0" : String(process.getuid!());
        return { exitCode: 0, stdout: `${out}\n`, stderr: "" };
      },
    };
    const db = openDatabase(":memory:");
    const store = new EnvironmentStore(db);
    const manager = new EnvironmentManager(store, new EventBus(), { dataDir: join(base, "data"), cliPath: "/cli.js", runner });
    const ws = workspace();
    store.set(ws, { mode: "imagem:base", idleMinutes: 30 });
    const authFile = join(base, "auth.json");
    writeFileSync(authFile, '{"anthropic":{"type":"api","key":"sk-test"}}');
    const variants: string[] = [];
    const launcher = new ContainerLauncher(() => ws, manager, {
      authFile,
      version: "1.19.4",
      cacheDir: join(base, "bin"),
      runner,
      binaryFor: async (v) => (variants.push(v), "/bin/opencode-musl"),
    });
    const engineDir = manager.engineDir(ws.id);
    const env = engineEnv({ dataDir: engineDir, password: "segredo", config: { model: "x/y" }, source: { PATH: "/usr/bin" } });
    const launched = await launcher.prepare(env);

    expect(variants).toEqual(["opencode-linux-x64-musl"]);
    expect(calls).toContainEqual(["docker", "cp", "/bin/opencode-musl", `c1:${CONTAINER_BINARY}`]);
    expect(calls).toContainEqual(["docker", "exec", "-u", "0", "c1", "sh", "-c", `chown root:root ${CONTAINER_BINARY} && chmod 755 ${CONTAINER_BINARY}`]);
    const copied = join(env.XDG_DATA_HOME!, "opencode", "auth.json");
    expect(readFileSync(copied, "utf8")).toContain("sk-test");
    expect(statSync(copied).mode & 0o777).toBe(0o600);

    const cmd = launched.command;
    expect(cmd.slice(0, 5)).toEqual(["docker", "exec", "-i", "-u", `${process.getuid!()}:${process.getgid!()}`]);
    expect(cmd.join(" ")).not.toContain("segredo"); // the password stays off the command line
    const envFile = cmd[cmd.indexOf("--env-file") + 1]!;
    const vars = readFileSync(envFile, "utf8");
    expect(vars).toContain("OPENCODE_SERVER_PASSWORD=segredo\n");
    expect(vars).toContain(`HOME=${join(engineDir, "home")}\n`);
    expect(vars).not.toContain("PATH=/usr/bin");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(envFile.startsWith(`${engineDir}/`)).toBe(false); // not inside the folder mounted in the container
    expect(launched.rewriteUrl("http://0.0.0.0:4096")).toBe("http://172.17.0.9:4096");

    // A stopped container (idle, or it died) is brought back up by the next engine start.
    await manager.stop(ws);
    const ups = () => calls.filter((c) => c[2] === "up").length;
    const before = ups();
    await launcher.prepare(env);
    expect(ups()).toBe(before + 1);
    expect(manager.status(ws).state).toBe("pronto");
  });
});

const hasDocker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const hasNode = Bun.spawnSync(["node", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const gateway = hasDocker
  ? Bun.spawnSync(["docker", "network", "inspect", "bridge", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"], { stdout: "pipe" }).stdout.toString().trim()
  : "";

describe.skipIf(!hasDocker || !hasNode || !gateway)("3.1 integração: motor real no container", () => {
  test("the engine runs in the container, writes as the user, and sees nothing of $HOME but the workspace", async () => {
    const llm = startMockLlm([], undefined, gateway);
    const db = openDatabase(":memory:");
    const store = new EnvironmentStore(db);
    const manager = new EnvironmentManager(store, new EventBus(), {
      dataDir: join(base, "real"),
      cliPath: Bun.resolveSync("@devcontainers/cli/devcontainer.js", import.meta.dir),
    });
    const ws = workspace();
    store.set(ws, { mode: "imagem:base", idleMinutes: 30 });
    const launcher = new ContainerLauncher(() => ws, manager, { authFile: join(base, "sem-auth.json"), version: "1.19.4", cacheDir: join(base, "bin") });
    const engine = new OpencodeEngine({
      dataDir: manager.engineDir(ws.id),
      config: () => ({ provider: llm.providerConfig, model: "mock/m" }),
      launcher,
      startTimeoutMs: 120_000,
    });
    try {
      await engine.ensureRunning();
      const tasks = join(ws.rootPath, "openspec", "changes", "c", "tasks.md");
      llm.setScript([
        { tool: "write", args: { filePath: join(ws.rootPath, "src", "novo.ts"), content: "x\n" } },
        { tool: "bash", args: { command: "ls -a ~/.. /home 2>&1; id -u", description: "olhar" } },
      ]);
      const sessionId = await engine.createSession({
        directory: ws.rootPath,
        permission: applyPermissions({ root: ws.rootPath, members: [ws.rootPath], tasksFile: tasks, commands: ["ls -a ~/.. /home 2>&1; id -u"] }),
      });
      const idle = new Promise<void>((resolve) => {
        const off = engine.onEvent((e: EngineEvent) => {
          if ((e.kind === "idle" || e.kind === "error") && e.sessionId === sessionId) (off(), resolve());
        });
      });
      await engine.prompt(sessionId, "faça", { directory: ws.rootPath, model: llm.model });
      await idle;
      const novo = join(ws.rootPath, "src", "novo.ts");
      expect(readFileSync(novo, "utf8")).toBe("x\n");
      expect(statSync(novo).uid).toBe(process.getuid!());

      const container = (await processRunner.run(["docker", "ps", "-q", "--filter", `label=studio.workspace=${ws.id}`])).stdout.trim();
      // The container's user cannot replace the engine binary.
      const tamper = await processRunner.run(["docker", "exec", "-u", String(process.getuid!()), container, "sh", "-c", `cp /bin/true ${CONTAINER_BINARY}`]);
      expect(tamper.exitCode).not.toBe(0);
      // Nothing of the user's $HOME is in the container, except the workspace and the app data mounted at their paths.
      const home = process.env.HOME!;
      const listed = await processRunner.run(["docker", "exec", container, "sh", "-c", `ls -A '${home}' 2>/dev/null; test -e '${home}/.ssh' && echo SSH`]);
      expect(listed.stdout).not.toContain("SSH");
      const mounts = (await processRunner.run(["docker", "inspect", "-f", "{{range .Mounts}}{{.Source}}\n{{end}}", container])).stdout.trim().split("\n");
      for (const m of mounts) {
        const allowed = [ws.rootPath, manager.engineDir(ws.id)].some((p) => m === p);
        expect({ m, allowed }).toEqual({ m, allowed: true });
      }
      expect(existsSync(join(manager.engineDir(ws.id), "engine.pid"))).toBe(true);
    } finally {
      await engine.stop();
      await llm.stop();
      const ids = (await processRunner.run(["docker", "ps", "-aq", "--filter", `label=studio.workspace=${ws.id}`])).stdout.trim().split("\n").filter(Boolean);
      if (ids.length) await processRunner.run(["docker", "rm", "-f", ...ids]);
    }
  }, 300_000);
});
