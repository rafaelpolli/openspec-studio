import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOKEN_HEADER, type RegisterWorkspaceResult, type WorkspaceView } from "@studio/shared";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createToken } from "../security.ts";
import { buildFixtureRoot, sandbox } from "../testing/fixture.ts";
import { WorkspaceRepo } from "./repo.ts";
import { WorkspaceService } from "./service.ts";
import { WorkspaceWatcher } from "./watcher.ts";

const { dir, cli } = sandbox("studio-ws-");
const openspec = new OpenSpecAdapter(cli);
const dbFile = join(dir, "studio.db");
const token = createToken();
const watchers: WorkspaceWatcher[] = [];

/** Builds a fresh app over the same database file, as after a restart. */
function boot() {
  const db = openDatabase(dbFile);
  const watcher = new WorkspaceWatcher(new EventBus());
  watchers.push(watcher);
  const service = new WorkspaceService(new WorkspaceRepo(db), openspec, watcher);
  service.start();
  const app = createApp({ token, allowedOrigins: [], events: new EventBus(), workspaces: service });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, call };
}

const repoPath = join(dir, "meu-app");
beforeAll(() => buildFixtureRoot(repoPath, cli), 60_000);
afterAll(() => {
  for (const w of watchers) w.close();
  rmSync(dir, { recursive: true, force: true });
});

let monoId = "";

describe("mono-repo workspaces", () => {
  test("Pasta com OpenSpec inicializado: root and single member are the folder", async () => {
    const { call } = boot();
    const res = await call("POST", "/workspaces", { kind: "mono", path: repoPath });
    expect(res.status).toBe(201);
    const { workspace, issues } = (await res.json()) as RegisterWorkspaceResult;
    expect(workspace).toMatchObject({
      name: "meu-app",
      kind: "mono",
      rootPath: repoPath,
      storeId: null,
      members: [{ name: "meu-app", path: repoPath }],
      projectType: "inicializado",
    });
    expect(issues).toEqual([]);
    monoId = workspace.id;
  });

  test("Pasta inexistente: registration is refused as invalid", async () => {
    const { call } = boot();
    const res = await call("POST", "/workspaces", { kind: "mono", path: join(dir, "nope") });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_input" } });

    const file = join(dir, "a-file.txt");
    writeFileSync(file, "x");
    expect((await call("POST", "/workspaces", { kind: "mono", path: file })).status).toBe(400);
  });

  test("malformed input is rejected", async () => {
    const { call } = boot();
    expect((await call("POST", "/workspaces", { kind: "mono" })).status).toBe(400);
  });
});

describe("multi-repo workspaces", () => {
  const storePath = join(dir, "specs-store");
  const api = join(dir, "repo-api");
  const web = join(dir, "repo-web");

  test("creates a store", async () => {
    const { call } = boot();
    const res = await call("POST", "/stores", { id: "specs-store", path: storePath, initGit: false });
    expect(res.status).toBe(201);
    expect(existsSync(join(storePath, "openspec/config.yaml"))).toBe(true);
  });

  test("Store com repos membros: root is the store and members are the repos", async () => {
    for (const repo of [api, web]) {
      mkdirSync(join(repo, "openspec"), { recursive: true });
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src/main.ts"), "x");
      writeFileSync(join(repo, "openspec/config.yaml"), "store: specs-store\n");
    }
    const { call } = boot();
    const res = await call("POST", "/workspaces", { kind: "multi", storeId: "specs-store", members: [api, web] });
    expect(res.status).toBe(201);
    const { workspace, issues } = (await res.json()) as RegisterWorkspaceResult;
    expect(workspace).toMatchObject({
      name: "specs-store",
      kind: "multi",
      rootPath: storePath,
      storeId: "specs-store",
      members: [
        { name: "repo-api", path: api },
        { name: "repo-web", path: web },
      ],
      projectType: "brownfield",
    });
    expect(issues).toEqual([]);
  });

  test("Membro que não declara o store: warns and writes the declaration only on confirmation", async () => {
    const legacy = join(dir, "repo-legacy");
    mkdirSync(join(legacy, "src"), { recursive: true });
    writeFileSync(join(legacy, "src/a.py"), "x");
    const { call } = boot();
    const res = await call("POST", "/workspaces", {
      kind: "multi",
      storeId: "specs-store",
      members: [api, legacy],
      name: "with-legacy",
    });
    const { workspace, issues } = (await res.json()) as RegisterWorkspaceResult;
    expect(issues).toEqual([
      {
        member: "repo-legacy",
        issue: "store_not_declared",
        message: "repo-legacy does not declare store 'specs-store'",
      },
    ]);
    expect(existsSync(join(legacy, "openspec"))).toBe(false);

    const confirm = await call("POST", `/workspaces/${workspace.id}/members/repo-legacy/declare-store`);
    expect(confirm.status).toBe(204);
    expect(readFileSync(join(legacy, "openspec/config.yaml"), "utf8")).toBe("store: specs-store\n");
    expect(await (await call("GET", `/workspaces/${workspace.id}/issues`)).json()).toEqual([]);
  });

  test("an unregistered store is refused", async () => {
    const { call } = boot();
    const res = await call("POST", "/workspaces", { kind: "multi", storeId: "ghost", members: [api] });
    expect(res.status).toBe(400);
  });
});

describe("listing, removal and persistence", () => {
  test("workspaces survive a restart", async () => {
    const { call } = boot();
    const list = (await (await call("GET", "/workspaces")).json()) as WorkspaceView[];
    expect(list.map((w) => w.name)).toEqual(["meu-app", "specs-store", "with-legacy"]);
    expect(list[0]).toMatchObject({ id: monoId, rootPath: repoPath, members: [{ path: repoPath }] });
  });

  test("Remoção: removes from the list without touching files", async () => {
    const before = readdirSync(repoPath, { recursive: true }).sort();
    const { call } = boot();
    expect((await call("DELETE", `/workspaces/${monoId}`)).status).toBe(204);
    expect((await call("GET", `/workspaces/${monoId}`)).status).toBe(404);
    const list = (await (await call("GET", "/workspaces")).json()) as WorkspaceView[];
    expect(list.map((w) => w.name)).not.toContain("meu-app");
    expect(readdirSync(repoPath, { recursive: true }).sort()).toEqual(before);
    expect((await call("DELETE", `/workspaces/${monoId}`)).status).toBe(404);
  });
});

describe("file access", () => {
  test("reads inside the workspace and denies paths outside", async () => {
    const { call } = boot();
    const [ws] = (await (await call("GET", "/workspaces")).json()) as WorkspaceView[];
    const inside = await call("GET", `/workspaces/${ws!.id}/file?path=${encodeURIComponent("openspec/config.yaml")}`);
    expect(inside.status).toBe(200);
    expect(await inside.text()).toContain("schema");

    const outside = await call("GET", `/workspaces/${ws!.id}/file?path=${encodeURIComponent("../studio.db")}`);
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ error: { code: "forbidden" } });
  });
});
