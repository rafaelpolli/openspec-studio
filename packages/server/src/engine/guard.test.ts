import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { EventBus } from "../events.ts";
import { openDatabase } from "../db.ts";
import { FakeEngine } from "../testing/fake-engine.ts";
import { applyPermissions, engineWorktree, sessionPermissions, WriteGuard } from "./guard.ts";
import { AgentRunner } from "./runner.ts";
import { ChangeSessions } from "./sessions.ts";

const base = mkdtempSync(join(tmpdir(), "studio-guard-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function folder(name: string, files: Record<string, string>): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function gitRepo(name: string, files: Record<string, string>): string {
  const dir = folder(name, files);
  const run = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  run("init", "-q");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return dir;
}

const tick = () => Bun.sleep(15); // let mtimes move past the snapshot

describe("WriteGuard (6.6 / D8)", () => {
  test("writes inside the OpenSpec root are allowed", async () => {
    const store = folder("store", { "openspec/config.yaml": "x" });
    const guard = new WriteGuard([store], join(store, "openspec"));
    guard.begin();
    await tick();
    writeFileSync(join(store, "openspec/new.md"), "ok");
    expect(guard.finish()).toEqual([]);
  });

  test("a write in a member that is a clean Git repo is flagged and reverted", async () => {
    const api = gitRepo("api", { "src/main.ts": "original\n", "src/old.ts": "old\n" });
    const store = folder("store2", { "openspec/config.yaml": "x" });
    const guard = new WriteGuard([api], join(store, "openspec"));
    guard.begin();
    await tick();
    writeFileSync(join(api, "src/main.ts"), "hacked\n");
    writeFileSync(join(api, "src/new.ts"), "new\n");
    unlinkSync(join(api, "src/old.ts"));

    expect(guard.finish()).toEqual([
      { path: join(api, "src/main.ts"), change: "modificado", reverted: true },
      { path: join(api, "src/new.ts"), change: "criado", reverted: true },
      { path: join(api, "src/old.ts"), change: "removido", reverted: true },
    ]);
    expect(readFileSync(join(api, "src/main.ts"), "utf8")).toBe("original\n");
    expect(existsSync(join(api, "src/new.ts"))).toBe(false);
    expect(readFileSync(join(api, "src/old.ts"), "utf8")).toBe("old\n");
  });

  test("a member with local changes or without Git is only flagged, never reverted", async () => {
    const dirty = gitRepo("dirty", { "a.ts": "a\n" });
    writeFileSync(join(dirty, "wip.ts"), "user work in progress\n");
    const plain = folder("plain", { "b.py": "b\n" });
    const guard = new WriteGuard([dirty, plain], join(base, "nowhere/openspec"));
    guard.begin();
    await tick();
    writeFileSync(join(dirty, "a.ts"), "changed\n");
    writeFileSync(join(plain, "b.py"), "changed\n");
    expect(guard.finish()).toEqual([
      { path: join(dirty, "a.ts"), change: "modificado", reverted: false },
      { path: join(plain, "b.py"), change: "modificado", reverted: false },
    ]);
    expect(readFileSync(join(dirty, "wip.ts"), "utf8")).toBe("user work in progress\n");
    expect(readFileSync(join(plain, "b.py"), "utf8")).toBe("changed\n");
  });

  test("mono-repo: code outside openspec/ in the same folder is guarded", async () => {
    const repo = folder("mono", { "openspec/config.yaml": "x", "src/app.ts": "x" });
    const guard = new WriteGuard([repo], join(repo, "openspec"));
    guard.begin();
    await tick();
    writeFileSync(join(repo, "openspec/ok.md"), "fine");
    writeFileSync(join(repo, "src/app.ts"), "nope");
    expect(guard.finish().map((v) => v.path)).toEqual([join(repo, "src/app.ts")]);
  });
});

describe("runner integration", () => {
  test("Escrita num membro é sinalizada: violations are attached to the finished run", async () => {
    const api = gitRepo("api-run", { "src/main.ts": "original\n" });
    const store = folder("store-run", { "openspec/config.yaml": "x" });
    const db = openDatabase(":memory:");
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'multi', '/s', 's', 'now')");
    const engine = new FakeEngine();
    engine.onPrompt = async (call, e) => {
      await tick();
      writeFileSync(join(api, "src/main.ts"), "written by the agent\n");
      writeFileSync(join(store, "openspec/proposal.md"), "# P\n");
      e.emit({ kind: "idle", sessionId: call.sessionId });
    };
    const runner = new AgentRunner(engine, new ChangeSessions(db, engine), new EventBus());
    const permission = sessionPermissions(store, [api]);
    const handle = await runner.start({
      workspaceId: "w",
      change: "add-x",
      directory: store,
      text: "go",
      permission,
      guard: new WriteGuard([api], join(store, "openspec")),
    });
    const done = await handle.done;
    expect(done.status).toBe("concluido");
    expect(done.violations).toEqual([{ path: join(api, "src/main.ts"), change: "modificado", reverted: true }]);
    expect(readFileSync(join(api, "src/main.ts"), "utf8")).toBe("original\n");
    expect(engine.permissions.get(handle.run.sessionId)).toEqual(permission);
  });

  test("sessionPermissions: write only under openspec/, no shell, read in every member", () => {
    expect(sessionPermissions("/store", ["/repo-api", "/repo-web"], [], "/")).toEqual([
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "/store/openspec/**", action: "allow" },
      { permission: "edit", pattern: "store/openspec/**", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "read", pattern: "/store/**", action: "allow" },
      { permission: "external_directory", pattern: "/store/**", action: "allow" },
      { permission: "read", pattern: "/repo-api/**", action: "allow" },
      { permission: "external_directory", pattern: "/repo-api/**", action: "allow" },
      { permission: "read", pattern: "/repo-web/**", action: "allow" },
      { permission: "external_directory", pattern: "/repo-web/**", action: "allow" },
    ]);
    // Mono-repo: the member is the root itself, so it is not listed twice.
    expect(sessionPermissions("/app", ["/app"], [], "/").filter((r) => r.permission === "read")).toHaveLength(1);
  });

  test("sessionPermissions: edit rules relative to the Git worktree (D8)", () => {
    const repo = gitRepo("wt-repo", { "README.md": "x\n" });
    const edits = sessionPermissions(repo, [repo], ["/data/job"])
      .filter((r) => r.permission === "edit" && r.action === "allow")
      .map((r) => r.pattern);
    expect(edits).toEqual([
      `${repo}/openspec/**`,
      "openspec/**",
      "/data/job/**",
      `${relative(repo, "/data/job")}/**`,
    ]);
    expect(engineWorktree(repo)).toBe(repo);
    expect(engineWorktree(folder("wt-plain", {}))).toBe("/");
  });

  test("Escrita negada (add-change-verification 3.1): a read-only session may edit only its work folder, no shell", () => {
    const rules = sessionPermissions("/store", ["/repo-api"], ["/data/verify/v1"], "/", false);
    expect(rules.filter((r) => r.permission === "edit")).toEqual([
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "/data/verify/v1/**", action: "allow" },
      { permission: "edit", pattern: "data/verify/v1/**", action: "allow" },
    ]);
    expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "deny" });
    expect(rules).toContainEqual({ permission: "read", pattern: "/repo-api/**", action: "allow" });
  });

  test("Escrita negada: the guard flags writes in openspec/ and in members, not in the work folder", async () => {
    const api = gitRepo("api-verify", { "src/main.ts": "original\n" });
    const store = folder("store-verify", { "openspec/config.yaml": "x" });
    const work = folder("work-verify", {});
    const db = openDatabase(":memory:");
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'multi', '/s', 's', 'now')");
    const engine = new FakeEngine();
    engine.onPrompt = async (call, e) => {
      await tick();
      writeFileSync(join(api, "src/main.ts"), "written by the agent\n");
      writeFileSync(join(store, "openspec/proposal.md"), "# P\n");
      writeFileSync(join(work, "trace.json"), "{}");
      e.emit({ kind: "idle", sessionId: call.sessionId });
    };
    const runner = new AgentRunner(engine, new ChangeSessions(db, engine), new EventBus());
    const handle = await runner.start({
      workspaceId: "w",
      change: "verificacao",
      directory: store,
      text: "go",
      permission: sessionPermissions(store, [api], [work], "/", false),
      guard: new WriteGuard([api, store], work),
    });
    const done = await handle.done;
    expect(done.violations?.map((v) => v.path)).toEqual([join(api, "src/main.ts"), join(store, "openspec/proposal.md")].sort());
    expect(readFileSync(join(api, "src/main.ts"), "utf8")).toBe("original\n");
  });

  test("applyPermissions: write in members, tasks.md denied, listed commands, ask for the rest (apply D2)", () => {
    const rules = applyPermissions({
      root: "/store",
      members: ["/repo-api", "/repo-web"],
      tasksFile: "/store/openspec/changes/c/tasks.md",
      commands: ["bun test", "bun run build > out.log"],
      worktree: "/",
    });
    expect(rules).toEqual([
      { permission: "external_directory", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "/store/openspec/**", action: "allow" },
      { permission: "edit", pattern: "store/openspec/**", action: "allow" },
      { permission: "edit", pattern: "/repo-api/**", action: "allow" },
      { permission: "edit", pattern: "repo-api/**", action: "allow" },
      { permission: "edit", pattern: "/repo-web/**", action: "allow" },
      { permission: "edit", pattern: "repo-web/**", action: "allow" },
      { permission: "edit", pattern: "/store/openspec/changes/c/tasks.md", action: "deny" },
      { permission: "edit", pattern: "store/openspec/changes/c/tasks.md", action: "deny" },
      { permission: "read", pattern: "/store/**", action: "allow" },
      { permission: "external_directory", pattern: "/store", action: "allow" },
      { permission: "external_directory", pattern: "/store/**", action: "allow" },
      { permission: "read", pattern: "/repo-api/**", action: "allow" },
      { permission: "external_directory", pattern: "/repo-api", action: "allow" },
      { permission: "external_directory", pattern: "/repo-api/**", action: "allow" },
      { permission: "read", pattern: "/repo-web/**", action: "allow" },
      { permission: "external_directory", pattern: "/repo-web", action: "allow" },
      { permission: "external_directory", pattern: "/repo-web/**", action: "allow" },
      { permission: "bash", pattern: "bun test", action: "allow" },
      { permission: "bash", pattern: "bun test *", action: "allow" },
      { permission: "bash", pattern: "*>*", action: "ask" },
      { permission: "bash", pattern: "bun run build > out.log", action: "allow" },
      { permission: "bash", pattern: "bun run build > out.log *", action: "allow" },
    ]);
    // Mono-repo: the member is the root, whose whole tree is writable and readable once.
    const mono = applyPermissions({ root: "/app", members: ["/app"], tasksFile: "/app/openspec/changes/c/tasks.md", commands: [], worktree: "/app" });
    expect(mono.filter((r) => r.permission === "edit" && r.action === "allow").map((r) => r.pattern)).toEqual([
      "/app/openspec/**",
      "openspec/**",
      "/app/**",
      "*",
    ]);
    expect(mono).toContainEqual({ permission: "edit", pattern: "../*", action: "deny" });
    expect(mono.filter((r) => r.permission === "read")).toHaveLength(1);
  });
});
