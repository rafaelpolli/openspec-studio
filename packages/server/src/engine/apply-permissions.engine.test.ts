import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockLlm, type MockLlm, type ToolCall } from "../testing/mock-llm.ts";
import type { EngineEvent, PermissionRule } from "./engine.ts";
import { applyPermissions } from "./guard.ts";
import { OpencodeEngine } from "./opencode.ts";

// add-visual-apply task 2.1: the real engine enforces the apply rules; a scripted LLM drives the tools.
const base = mkdtempSync(join(tmpdir(), "studio-apply-perm-"));
let llm: MockLlm;
let engine: OpencodeEngine;
/** Sessions whose permission requests the test answers, like the app's apply sessions. */
const interactive = new Map<string, (requestId: string, directory: string) => Promise<void>>();

beforeAll(async () => {
  llm = startMockLlm();
  engine = new OpencodeEngine({
    dataDir: join(base, "engine"),
    config: () => ({ provider: llm.providerConfig, model: "mock/m" }),
    interactive: (sessionId) => interactive.has(sessionId),
  });
  engine.onEvent((event) => {
    if (event.kind === "permission") void interactive.get(event.sessionId)?.(event.request.requestId, event.directory);
  });
  await engine.ensureRunning();
}, 60_000);

afterAll(async () => {
  await engine?.stop();
  await llm?.stop();
  rmSync(base, { recursive: true, force: true });
});

function repo(name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, "openspec", "changes", "c"), { recursive: true });
  writeFileSync(join(dir, "openspec", "changes", "c", "tasks.md"), "- [ ] 1.1 x\n");
  writeFileSync(join(dir, "README.md"), "original\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

async function run(
  directory: string,
  script: ToolCall[],
  permission: PermissionRule[],
  answer?: (requestId: string, directory: string) => Promise<void>,
) {
  llm.setScript(script);
  const sessionId = await engine.createSession({ directory, title: "apply", permission });
  if (answer) interactive.set(sessionId, answer);
  const idle = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("a sessão não terminou (travou?)")), 30_000);
    const off = engine.onEvent((event: EngineEvent) => {
      if ((event.kind === "idle" || event.kind === "error") && event.sessionId === sessionId) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
  await engine.prompt(sessionId, "faça", { directory, model: llm.model });
  await idle;
  return llm.results.map((r) => r.output);
}

const write = (filePath: string, content = "escrito\n"): ToolCall => ({ tool: "write", args: { filePath, content } });
const bash = (command: string, workdir?: string): ToolCall => ({
  tool: "bash",
  args: { command, description: "comando", ...(workdir ? { workdir } : {}) },
});
const DENIED = "prevents you from using this specific tool call";
const REJECTED = "rejected permission";

describe("apply permissions on the real engine (add-visual-apply D2)", () => {
  test("multi-repo: writes in members and openspec/, never in tasks.md or outside", async () => {
    const store = repo("store");
    const api = repo("repo-api");
    const tasks = join(store, "openspec", "changes", "c", "tasks.md");
    const outside = join(base, "fora.txt");
    const out = await run(
      store,
      [
        write(join(api, "src", "novo.ts")),
        write(join(store, "openspec", "changes", "c", "notes.md")),
        write(tasks, "- [x] 1.1 x\n"),
        write(outside),
      ],
      applyPermissions({ root: store, members: [api], tasksFile: tasks, commands: [] }),
    );
    expect(readFileSync(join(api, "src", "novo.ts"), "utf8")).toBe("escrito\n");
    expect(existsSync(join(store, "openspec", "changes", "c", "notes.md"))).toBe(true);
    expect(readFileSync(tasks, "utf8")).toBe("- [ ] 1.1 x\n");
    expect(out[2]).toContain(DENIED);
    expect(existsSync(outside)).toBe(false);
  }, 60_000);

  test("mono-repo in Git: the whole repo is writable except tasks.md", async () => {
    const app = repo("mono");
    const tasks = join(app, "openspec", "changes", "c", "tasks.md");
    const out = await run(
      app,
      [write(join(app, "src", "a.ts")), write(join(app, "README.md")), write(tasks, "x\n"), write(join(base, "fora-mono.txt"))],
      applyPermissions({ root: app, members: [app], tasksFile: tasks, commands: [] }),
    );
    expect(readFileSync(join(app, "src", "a.ts"), "utf8")).toBe("escrito\n");
    expect(readFileSync(join(app, "README.md"), "utf8")).toBe("escrito\n");
    expect(out[2]).toContain(DENIED);
    expect(readFileSync(tasks, "utf8")).toBe("- [ ] 1.1 x\n");
    expect(existsSync(join(base, "fora-mono.txt"))).toBe(false);
  }, 60_000);

  test("listed commands run, in a member too; others and redirections become a permission request", async () => {
    const store = repo("store-cmd");
    const api = repo("api-cmd");
    const tasks = join(store, "openspec", "changes", "c", "tasks.md");
    const out = await run(
      store,
      [
        bash("echo ok"),
        bash("echo ok", api),
        bash("echo okay"),
        bash("echo ok && echo HACK"),
        bash("echo ok > saida.txt", api),
      ],
      applyPermissions({ root: store, members: [api], tasksFile: tasks, commands: ["echo ok"] }),
    );
    expect(out[0]).toBe("ok\n");
    expect(out[1]).toBe("ok\n");
    // Nobody answers in this test, so the engine's automatic rejection (D3) stands in for the user.
    for (const i of [2, 3, 4]) expect(out[i]).toContain(REJECTED);
    expect(existsSync(join(api, "saida.txt"))).toBe(false);
  }, 60_000);

  test("apply sessions forward the request: once runs the command, reject hands the agent the reason (D3)", async () => {
    const store = repo("store-ask");
    const tasks = join(store, "openspec", "changes", "c", "tasks.md");
    const rules = applyPermissions({ root: store, members: [store], tasksFile: tasks, commands: [] });
    const asked: string[][] = [];
    const off = engine.onEvent((e) => {
      if (e.kind === "permission") asked.push(e.request.patterns);
    });
    let answered = 0;
    const out = await run(store, [bash("echo um"), bash("echo dois"), bash("echo tres")], rules, async (id, dir) => {
      await engine.replyPermission(id, dir, answered++ === 0 ? "once" : "reject", "o usuário recusou");
    });
    off();
    expect(asked[0]).toEqual(["echo um"]);
    expect(out[0]).toBe("um\n");
    expect(out[1]).toContain("o usuário recusou");
    // The agent carried on after the rejection: the next tool call was made (and asked again).
    expect(out).toHaveLength(3);
    expect(asked).toHaveLength(3);
  }, 60_000);
});
