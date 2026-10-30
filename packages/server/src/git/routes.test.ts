import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOKEN_HEADER, type GitState, type ServerEvent, type Workspace } from "@studio/shared";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createToken } from "../security.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import { OpenSpecCli } from "../openspec/cli.ts";
import { GitService } from "./service.ts";
import { gitSandbox } from "./testing.ts";

setDefaultTimeout(60_000);

const box = gitSandbox("studio-git-routes-");
const cli = new OpenSpecCli({ env: { XDG_DATA_HOME: join(box.dir, ".xdg") } });
const watcher = new WorkspaceWatcher(new EventBus());
afterAll(() => {
  watcher.close();
  rmSync(box.dir, { recursive: true, force: true });
});

let counter = 0;

/** A mono-repo workspace in Git, served by an app with the Git routes. */
async function gitApp(opts: { git?: boolean; busy?: boolean } = {}) {
  const root = box.folder(`ws-${++counter}`, { "src/a.ts": "a\n" }, { git: false });
  await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
  if (opts.git !== false) {
    box.sh(root, "init", "-q", "-b", "main");
    box.sh(root, "add", "-A");
    box.sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "inicial");
  }
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), new OpenSpecAdapter(cli), watcher);
  const ws: Workspace = (await workspaces.register({ kind: "mono", path: root })).workspace;
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const token = createToken();
  const git = new GitService(workspaces, box.client, events, () => opts.busy ?? false);
  const app = createApp({ token, allowedOrigins: [], events, workspaces, git });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { ws, root, call, seen };
}

describe("1.2 rotas de estado e identidade", () => {
  test("GET lists each area with its state and identity", async () => {
    box.globalIdentity("Global", "g@x");
    const { ws, root, call } = await gitApp();
    writeFileSync(join(root, "src/a.ts"), "mudou\n");
    const res = await call("GET", `/workspaces/${ws.id}/git`);
    expect(res.status).toBe(200);
    const state = res.body as GitState;
    expect(state.busy).toBe(false);
    expect(state.areas).toEqual([
      expect.objectContaining({ path: root, git: true, branch: "main", pending: 1, identity: expect.objectContaining({ name: "Global", nameScope: "global" }) }),
    ]);
  });

  test("PUT and DELETE the repo's identity, with an event each time", async () => {
    const { ws, root, call, seen } = await gitApp();
    const put = await call("PUT", `/workspaces/${ws.id}/git/identity`, { area: root, name: "Ana", email: "ana@empresa.com" });
    expect(put.status).toBe(200);
    expect(put.body.areas[0].identity).toMatchObject({ name: "Ana", nameScope: "local" });
    const del = await call("DELETE", `/workspaces/${ws.id}/git/identity`, { area: root });
    expect(del.body.areas[0].identity.nameScope).toBe("global");
    expect(seen.filter((e) => e.type === "git-changed")).toHaveLength(2);
  });

  test("bad input is 400; a path outside the workspace is 404; a folder without Git is 409", async () => {
    const { ws, root, call } = await gitApp();
    expect((await call("PUT", `/workspaces/${ws.id}/git/identity`, { area: root, name: "Ana", email: "sem-arroba" })).status).toBe(400);
    expect((await call("PUT", `/workspaces/${ws.id}/git/identity`, { area: "/etc", name: "Ana", email: "a@a" })).status).toBe(404);
    expect((await call("GET", `/workspaces/nao-existe/git`)).status).toBe(404);
    const plain = await gitApp({ git: false });
    expect((await plain.call("PUT", `/workspaces/${plain.ws.id}/git/identity`, { area: plain.root, name: "Ana", email: "a@a" })).status).toBe(409);
  });
});

describe("3.2 rotas de inicialização", () => {
  test("preview then init a workspace without Git", async () => {
    const { ws, root, call, seen } = await gitApp({ git: false });
    const preview = await call("POST", `/workspaces/${ws.id}/git/init/preview`, { area: root });
    expect(preview.status).toBe(200);
    expect(preview.body.files.map((f: { path: string }) => f.path)).toContain("src/a.ts");
    const done = await call("POST", `/workspaces/${ws.id}/git/init`, { area: root, gitignore: preview.body.gitignore, message: "Estado inicial" });
    expect(done.status).toBe(200);
    expect(done.body.areas[0]).toMatchObject({ git: true, pending: 0 });
    expect(seen.some((e) => e.type === "git-changed")).toBe(true);
  });

  test("Pasta já dentro de um repo: 409; no message: 400; a failing hook: 422 with the kind", async () => {
    const { ws, root, call } = await gitApp();
    expect((await call("POST", `/workspaces/${ws.id}/git/init/preview`, { area: root })).status).toBe(409);
    expect((await call("POST", `/workspaces/${ws.id}/git/init`, { area: root, gitignore: "", message: " " })).status).toBe(400);

    const plain = await gitApp({ git: false });
    const hooks = join(box.dir, "hooks-rota");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho recusado >&2\nexit 1\n", { mode: 0o755 });
    box.sh(box.dir, "config", "--global", "core.hooksPath", hooks);
    try {
      const res = await plain.call("POST", `/workspaces/${plain.ws.id}/git/init`, { area: plain.root, gitignore: ".env\n", message: "x" });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: "git_failed", kind: "hook", output: expect.stringContaining("recusado") });
    } finally {
      box.sh(box.dir, "config", "--global", "--unset", "core.hooksPath");
    }
  });
});

describe("4.1 rota de commitar pendências", () => {
  test("commits the pending changes; 409 while a task waits for review", async () => {
    const { ws, root, call } = await gitApp();
    writeFileSync(join(root, "src/a.ts"), "mudou\n");
    const done = await call("POST", `/workspaces/${ws.id}/git/commit-pending`, { area: root, message: "ajustes" });
    expect(done.status).toBe(200);
    expect(done.body.areas[0].pending).toBe(0);

    const busy = await gitApp({ busy: true });
    writeFileSync(join(busy.root, "src/a.ts"), "mudou\n");
    const res = await busy.call("POST", `/workspaces/${busy.ws.id}/git/commit-pending`, { area: busy.root, message: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("aceite ou desfaça a task");
    expect((await busy.call("GET", `/workspaces/${busy.ws.id}/git`)).body.busy).toBe(true);
  });
});
