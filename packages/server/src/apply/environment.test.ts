import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOKEN_HEADER, type EnvironmentSettings, type RegisterWorkspaceResult } from "@studio/shared";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createToken } from "../security.ts";
import { sandbox } from "../testing/fixture.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import { EnvironmentStore } from "./environment.ts";

setDefaultTimeout(60_000);

const { dir, cli } = sandbox("studio-env-");
const adapter = new OpenSpecAdapter(cli);
const watcher = new WorkspaceWatcher(new EventBus());
afterAll(() => {
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;

function folder(path: string, devcontainer = false): string {
  mkdirSync(join(path, "src"), { recursive: true });
  writeFileSync(join(path, "src", "main.ts"), "x\n");
  if (devcontainer) {
    mkdirSync(join(path, ".devcontainer"));
    writeFileSync(join(path, ".devcontainer", "devcontainer.json"), '{ "image": "mcr.microsoft.com/devcontainers/base:debian" }\n');
  }
  return path;
}

async function setup(kind: "mono" | "multi", devcontainers: boolean[]) {
  const base = join(dir, `case-${++counter}`);
  mkdirSync(base, { recursive: true });
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), adapter, watcher);
  const token = createToken();
  const app = createApp({ token, allowedOrigins: [], events: new EventBus(), workspaces, environments: new EnvironmentStore(db) });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  let body: unknown;
  let members: string[];
  if (kind === "mono") {
    const root = folder(join(base, "app"), devcontainers[0]);
    await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
    members = [root];
    body = { kind: "mono", path: root };
  } else {
    const root = join(base, "store");
    await adapter.storeSetup(base, `store-${counter}`, root, { initGit: false });
    members = ["repo-api", "repo-web"].map((n, i) => folder(join(base, n), devcontainers[i]));
    body = { kind: "multi", storeId: `store-${counter}`, members };
  }
  const ws = ((await call("POST", "/workspaces", body)).json as RegisterWorkspaceResult).workspace.id;
  const path = `/workspaces/${ws}/apply/environment`;
  const settings = async () => (await call("GET", path)).json as EnvironmentSettings;
  return { members, call, path, settings };
}

describe("2.1 ambiente do apply por workspace", () => {
  test("Projeto com devcontainer: a member's devcontainer.json is suggested", async () => {
    const t = await setup("multi", [true, false]);
    const s = await t.settings();
    const file = join(t.members[0]!, ".devcontainer", "devcontainer.json");
    expect(s.devcontainers).toEqual([{ member: "repo-api", path: file }]);
    expect(s.suggested).toBe(`devcontainer:${file}`);
    expect(s.images.map((i) => i.id)).toEqual(["base", "node", "python"]);
  });

  test("Mais de um devcontainer: both are listed for the user to choose", async () => {
    const t = await setup("multi", [true, true]);
    const s = await t.settings();
    expect(s.devcontainers.map((d) => d.member)).toEqual(["repo-api", "repo-web"]);
    const chosen = s.devcontainers[1]!.path;
    const put = await t.call("PUT", t.path, { mode: `devcontainer:${chosen}`, idleMinutes: 45 });
    expect(put.status).toBe(200);
    expect((put.json as EnvironmentSettings).config).toEqual({ mode: `devcontainer:${chosen}`, idleMinutes: 45 });
    expect((await t.settings()).config.mode).toBe(`devcontainer:${chosen}`);
  });

  test("a workspace with nothing stored runs on the machine, as before this change", async () => {
    const t = await setup("mono", [true]);
    expect((await t.settings()).config).toEqual({ mode: "local", idleMinutes: 30 });
  });

  test("Projeto sem devcontainer: a stock image or no container; invalid choices are refused", async () => {
    const t = await setup("mono", [false]);
    const s = await t.settings();
    expect(s.devcontainers).toEqual([]);
    expect(s.suggested).toBeUndefined();
    expect((await t.call("PUT", t.path, { mode: "imagem:node", idleMinutes: 30 })).json.config.mode).toBe("imagem:node");
    expect((await t.call("PUT", t.path, { mode: "local", idleMinutes: 30 })).json.config.mode).toBe("local");
    expect((await t.call("PUT", t.path, { mode: "imagem:cobol", idleMinutes: 30 })).status).toBe(400);
    expect((await t.call("PUT", t.path, { mode: "devcontainer:/etc/devcontainer.json", idleMinutes: 30 })).status).toBe(400);
    expect((await t.call("PUT", t.path, { mode: "nuvem", idleMinutes: 30 })).status).toBe(400);
    expect((await t.call("PUT", t.path, { mode: "local", idleMinutes: 0 })).status).toBe(400);
  });
});
