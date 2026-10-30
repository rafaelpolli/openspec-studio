import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOKEN_HEADER, type RegisterWorkspaceResult } from "@studio/shared";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { OpenSpecCli } from "../openspec/cli.ts";
import { createToken } from "../security.ts";
import { buildFixtureRoot, sandbox } from "../testing/fixture.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import { DashboardService } from "./service.ts";

const { dir, cli } = sandbox("studio-dash-");
const root = join(dir, "repo");
const token = createToken();
const watcher = new WorkspaceWatcher(new EventBus());

function build(adapter: OpenSpecAdapter) {
  const workspaces = new WorkspaceService(new WorkspaceRepo(openDatabase(":memory:")), adapter, watcher);
  const app = createApp({
    token,
    allowedOrigins: [],
    events: new EventBus(),
    workspaces,
    dashboard: new DashboardService(workspaces, adapter),
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Tests assert on loosely-typed JSON bodies.
    const json: any = await res.json();
    return { status: res.status, body: json };
  };
}

const call = build(new OpenSpecAdapter(cli));
let ws = "";

beforeAll(async () => {
  await buildFixtureRoot(root, cli);
  const res = await call("POST", "/workspaces", { kind: "mono", path: root });
  ws = (res.body as RegisterWorkspaceResult).workspace.id;
}, 60_000);
afterAll(() => {
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dashboard API", () => {
  test("lists specs with purpose and requirement count", async () => {
    expect((await call("GET", `/workspaces/${ws}/specs`)).body).toEqual([
      { id: "auth", purpose: "Describes how users authenticate in the existing system today.", requirementCount: 1 },
    ]);
  });

  test("shows a spec with requirements and scenarios", async () => {
    const { body } = await call("GET", `/workspaces/${ws}/specs/auth`);
    expect(body.requirements[0]).toMatchObject({ name: "Login", scenarios: [{ name: "Expired token" }] });
  });

  test("lists changes with task progress", async () => {
    expect((await call("GET", `/workspaces/${ws}/changes`)).body).toMatchObject([
      { name: "add-export", completedTasks: 1, totalTasks: 2 },
    ]);
  });

  test("returns the artifact graph, artifact files and tasks", async () => {
    const status = await call("GET", `/workspaces/${ws}/changes/add-export/status`);
    expect(status.body.artifacts.map((a: { id: string; status: string }) => [a.id, a.status])).toEqual([
      ["proposal", "done"],
      ["specs", "done"],
      ["design", "ready"],
      ["tasks", "done"],
    ]);

    const specs = await call("GET", `/workspaces/${ws}/changes/add-export/artifacts/specs`);
    expect(specs.body).toEqual([{ path: "specs/export/spec.md", content: expect.stringContaining("Export CSV") }]);
    expect((await call("GET", `/workspaces/${ws}/changes/add-export/artifacts/design`)).body).toEqual([]);

    const tasks = await call("GET", `/workspaces/${ws}/changes/add-export/tasks`);
    expect(tasks.body).toMatchObject({ total: 2, complete: 1, sections: [{ title: "1. Core" }] });
  });

  test("validates on demand and reports issues per item", async () => {
    const { status, body } = await call("POST", `/workspaces/${ws}/validate`, { item: "add-export" });
    expect(status).toBe(200);
    expect(body.items[0]).toMatchObject({ id: "add-export", valid: false });
  });

  test("rejects a malformed change name", async () => {
    expect((await call("GET", `/workspaces/${ws}/changes/..%2Fx/status`)).status).toBe(400);
  });

  test("reports the CLI as available, or unavailable when missing", async () => {
    expect((await call("GET", "/system")).body.openspec).toMatchObject({ available: true });

    const missing = build(new OpenSpecAdapter(new OpenSpecCli({ bin: join(dir, "no-openspec") })));
    const system = await missing("GET", "/system");
    expect(system.body.openspec.available).toBe(false);
    const reg = await missing("POST", "/workspaces", { kind: "mono", path: root });
    const specs = await missing("GET", `/workspaces/${reg.body.workspace.id}/specs`);
    expect(specs.status).toBe(503);
    expect(specs.body.error.code).toBe("cli_unavailable");
  });
});
