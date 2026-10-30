import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ContextReport, TOKEN_HEADER, type RegisterWorkspaceResult, type WorkspaceView } from "@studio/shared";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createToken } from "../security.ts";
import { buildFixtureRoot, sandbox } from "../testing/fixture.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";

const { dir, cli } = sandbox("studio-init-");
const token = createToken();
const watcher = new WorkspaceWatcher(new EventBus());
const service = new WorkspaceService(new WorkspaceRepo(openDatabase(":memory:")), new OpenSpecAdapter(cli), watcher);
const app = createApp({ token, allowedOrigins: [], events: new EventBus(), workspaces: service });

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Tests assert on loosely-typed JSON bodies.
  const json: any = await res.json().catch(() => undefined);
  return { status: res.status, body: json };
}

async function register(body: unknown): Promise<WorkspaceView> {
  const res = await call("POST", "/workspaces", body);
  expect(res.status).toBe(201);
  return (res.body as RegisterWorkspaceResult).workspace;
}

function folder(name: string, files: Record<string, string> = {}): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  return path;
}

/** Every file under `path`, relative, for before/after comparisons. */
function listing(path: string): string[] {
  return readdirSync(path, { recursive: true, encoding: "utf8" }).sort();
}

afterAll(() => {
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("init wizard (spec: project-onboarding)", () => {
  test("Wizard greenfield: pt-BR creates openspec/ with the OpenCode commands", async () => {
    const path = folder("novo");
    const ws = await register({ kind: "mono", path });
    expect(ws).toMatchObject({ projectType: "greenfield", needsInit: true, hasOpenSpec: false });

    const res = await call("POST", `/workspaces/${ws.id}/init`, { language: "pt-BR" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectType: "inicializado", needsInit: false, hasOpenSpec: true });
    expect(existsSync(join(path, ".opencode", "commands", "opsx-propose.md"))).toBe(true);
    expect(readFileSync(join(path, "openspec", "config.yaml"), "utf8")).toContain("Language: pt-BR");
  }, 30_000);

  test("a brownfield folder stays brownfield after init, ready for discovery", async () => {
    const path = folder("legado", { "src/app.ts": "export const x = 1;\n" });
    const ws = await register({ kind: "mono", path });
    expect(ws.projectType).toBe("brownfield");
    const res = await call("POST", `/workspaces/${ws.id}/init`, { language: "en" });
    expect(res.body).toMatchObject({ projectType: "brownfield", needsInit: false, hasOpenSpec: true });
  }, 30_000);

  test("Raiz já inicializada: refuses without touching anything", async () => {
    const path = join(dir, "pronto");
    await buildFixtureRoot(path, cli);
    const ws = await register({ kind: "mono", path });
    expect(ws.needsInit).toBe(false);
    const before = listing(path);
    const config = readFileSync(join(path, "openspec", "config.yaml"), "utf8");

    const res = await call("POST", `/workspaces/${ws.id}/init`, { language: "pt-BR" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("já está inicializado");
    expect(listing(path)).toEqual(before);
    expect(readFileSync(join(path, "openspec", "config.yaml"), "utf8")).toBe(config);
  }, 60_000);

  test("multi-repo: configures the store and leaves the members untouched", async () => {
    const storePath = join(dir, "store");
    expect((await call("POST", "/stores", { id: "init-store", path: storePath, initGit: false })).status).toBe(201);
    const api = folder("repo-api", { "server.ts": "export {};\n" });
    const web = folder("repo-web", { "index.html": "<html></html>\n" });
    const before = [listing(api), listing(web)];
    const ws = await register({ kind: "multi", storeId: "init-store", members: [api, web] });
    expect(ws).toMatchObject({ needsInit: true, projectType: "brownfield" });

    const res = await call("POST", `/workspaces/${ws.id}/init`, { language: "pt-BR" });
    expect(res.status).toBe(200);
    expect(res.body.needsInit).toBe(false);
    expect(existsSync(join(storePath, ".opencode", "commands", "opsx-propose.md"))).toBe(true);
    const config = readFileSync(join(storePath, "openspec", "config.yaml"), "utf8");
    expect(config).toMatch(/^schema: spec-driven\n\ncontext: \|\n  Language: pt-BR\n/);
    expect([listing(api), listing(web)]).toEqual(before);

    // The CLI still reads the store's config after the edit.
    expect((await cli.json(["context"], ContextReport, { cwd: storePath })).root).toBeTruthy();
    expect((await call("POST", `/workspaces/${ws.id}/init`, { language: "pt-BR" })).status).toBe(409);
  }, 60_000);

  test("rejects an invalid language tag", async () => {
    const ws = await register({ kind: "mono", path: folder("outro") });
    expect((await call("POST", `/workspaces/${ws.id}/init`, { language: "pt BR; rm" })).status).toBe(400);
  });
});
