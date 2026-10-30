import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockLlm, type MockLlm, type ToolCall } from "../testing/mock-llm.ts";
import type { EngineEvent, PermissionRule } from "./engine.ts";
import { sessionPermissions } from "./guard.ts";
import { OpencodeEngine, UNANSWERED } from "./opencode.ts";

// Task 6.8: the real engine enforces the session rules; a scripted LLM drives the tools.
const base = mkdtempSync(join(tmpdir(), "studio-perm-"));
let llm: MockLlm;
let engine: OpencodeEngine;

beforeAll(async () => {
  llm = startMockLlm();
  engine = new OpencodeEngine({
    dataDir: join(base, "engine"),
    config: () => ({ provider: llm.providerConfig, model: "mock/m" }),
  });
  await engine.ensureRunning();
}, 60_000);

afterAll(async () => {
  await engine?.stop();
  await llm?.stop();
  rmSync(base, { recursive: true, force: true });
});

function project(name: string, git: boolean): string {
  const dir = join(base, name);
  mkdirSync(join(dir, "openspec", "changes", "x"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "projeto\n");
  if (git) {
    const run = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
    run("init", "-q");
    run("add", "-A");
    run("commit", "-q", "-m", "init");
  }
  return dir;
}

/** Runs one scripted session and resolves when it goes idle (or fails on timeout). */
async function run(directory: string, script: ToolCall[], permission: PermissionRule[], timeoutMs = 30_000) {
  llm.setScript(script);
  const sessionId = await engine.createSession({ directory, title: "perm", permission });
  const idle = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("a sessão não terminou (travou?)")), timeoutMs);
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
  return llm.results;
}

const write = (filePath: string, content = "escrito\n"): ToolCall => ({ tool: "write", args: { filePath, content } });

describe("session permissions on the real engine (6.8 / D8)", () => {
  for (const git of [false, true]) {
    test(`a write under openspec/ is allowed (${git ? "with" : "without"} git)`, async () => {
      const root = project(`ok-${git}`, git);
      const target = join(root, "openspec", "changes", "x", "proposal.md");
      await run(root, [write(target)], sessionPermissions(root, [root]));
      expect(readFileSync(target, "utf8")).toBe("escrito\n");
    }, 60_000);
  }

  test("control: an edit rule with only the absolute path never matches (the bug D8 records)", async () => {
    const root = project("absolute-only", false);
    const target = join(root, "openspec", "changes", "x", "proposal.md");
    const absoluteOnly = sessionPermissions(root, [root]).filter(
      (r) => !(r.permission === "edit" && r.action === "allow" && !r.pattern.startsWith("/")),
    );
    const results = await run(root, [write(target)], absoluteOnly);
    expect(existsSync(target)).toBe(false);
    expect(results[0]!.output).toContain("prevents you from using this specific tool call");
  }, 60_000);

  test("a write to a member or outside the root is denied", async () => {
    const store = project("store", false);
    const member = project("member", true);
    const outside = join(base, "fora.txt");
    const results = await run(
      store,
      [write(join(member, "README.md"), "invadido\n"), write(outside), write(join(store, "README.md"), "x\n")],
      sessionPermissions(store, [member]),
    );
    expect(readFileSync(join(member, "README.md"), "utf8")).toBe("projeto\n");
    expect(existsSync(outside)).toBe(false);
    expect(readFileSync(join(store, "README.md"), "utf8")).toBe("projeto\n");
    expect(results).toHaveLength(3);
  }, 60_000);

  test("a read outside the allowed folders is refused without stalling the session", async () => {
    const root = project("read", false);
    const secret = join(base, "segredo.txt");
    writeFileSync(secret, "não deveria sair\n");
    const results = await run(root, [{ tool: "read", args: { filePath: secret } }], sessionPermissions(root, [root]));
    expect(results).toHaveLength(1);
    expect(results[0]!.output).not.toContain("não deveria sair");
  }, 60_000);

  test("a permission prompt (ask) is rejected automatically instead of waiting", async () => {
    // Without the app's rules the engine's default for external folders is "ask".
    const root = project("ask", false);
    const secret = join(base, "pergunta.txt");
    writeFileSync(secret, "não deveria sair\n");
    const results = await run(root, [{ tool: "read", args: { filePath: secret } }], []);
    expect(results).toHaveLength(1);
    expect(results[0]!.output).toContain("fora das pastas liberadas");
  }, 60_000);
});

describe("agent questions on the real engine (6.9)", () => {
  test("a question is answered automatically, reported, and the session finishes", async () => {
    const root = project("question", false);
    const asked: string[] = [];
    const off = engine.onEvent((event) => {
      if (event.kind === "question") asked.push(...event.questions);
    });
    const question = {
      question: "Qual banco de dados usar?",
      header: "Banco",
      options: [
        { label: "SQLite", description: "local" },
        { label: "Postgres", description: "servidor" },
      ],
    };
    const results = await run(root, [{ tool: "question", args: { questions: [question] } }], sessionPermissions(root, [root]));
    off();
    expect(asked).toEqual(["Qual banco de dados usar?"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.output).toContain(UNANSWERED);
  }, 60_000);
});
