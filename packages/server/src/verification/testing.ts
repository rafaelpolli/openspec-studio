import type { ServerEvent, Workspace } from "@studio/shared";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyRepo } from "../apply/repo.ts";
import { processRunner } from "../apply/environments.ts";
import { openDatabase } from "../db.ts";
import { AgentRunner } from "../engine/runner.ts";
import { ChangeSessions } from "../engine/sessions.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { FakeEngine, type PromptCall } from "../testing/fake-engine.ts";
import { sandbox } from "../testing/fixture.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import type { GitClient } from "../git/exec.ts";
import { VerificationRepo } from "./repo.ts";
import { VerificationService, type TestEnvironment } from "./service.ts";

/** A delta spec with one ADDED requirement and the given scenarios. */
export function deltaSpec(requirement: string, scenarios: string[]): string {
  return [
    "## ADDED Requirements",
    "",
    `### Requirement: ${requirement}`,
    "O sistema SHALL fazer algo.",
    "",
    ...scenarios.flatMap((s) => [`#### Scenario: ${s}`, `- **WHEN** ${s}`, "- **THEN** ok", ""]),
  ].join("\n");
}

/** The test file of the test project: one passing and one failing test, under a describe. */
export const TEST_FILE = [
  'import { describe, expect, test } from "bun:test";', // 1
  'import { soma } from "./soma.ts";', // 2
  "", // 3
  'describe("soma", () => {', // 4
  '  test("Passa: soma dois números", () => {', // 5
  "    expect(soma(1, 2)).toBe(3);", // 6
  "  });", // 7
  '  test("Falha: sempre falha", () => {', // 8
  "    expect(soma(1, 1)).toBe(3);", // 9
  "  });", // 10
  "});", // 11
  "",
].join("\n");

export function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString();
}

/**
 * A mono-repo workspace in Git with a `bun test` project, an OpenSpec change `c` whose delta
 * spec has `scenarios`, and a verification service with a scripted agent: `trace` decides
 * what the agent writes to trace.json (or `"hang"` to never finish).
 */
export async function verificationSetup(opts: {
  scenarios?: string[];
  spec?: string;
  tasks?: string;
  trace?: (prompt: PromptCall) => unknown | "hang" | "fail";
  timeoutMs?: number;
  git?: GitClient;
}) {
  const { dir, cli } = sandbox("studio-verify-");
  const adapter = new OpenSpecAdapter(cli);
  const watcher = new WorkspaceWatcher(new EventBus());
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), adapter, watcher);
  const root = join(dir, "app");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"app","scripts":{"test":"bun test"}}\n');
  writeFileSync(join(root, "bun.lock"), "");
  writeFileSync(join(root, "src", "soma.ts"), "export const soma = (a: number, b: number) => a + b;\n");
  writeFileSync(join(root, "src", "soma.test.ts"), TEST_FILE);
  await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
  await cli.run(["new", "change", "c"], { cwd: root });
  const changeDir = join(root, "openspec", "changes", "c");
  mkdirSync(join(changeDir, "specs", "calc"), { recursive: true });
  writeFileSync(join(changeDir, "specs", "calc", "spec.md"), opts.spec ?? deltaSpec("Somar", opts.scenarios ?? ["Passa"]));
  writeFileSync(join(changeDir, "tasks.md"), opts.tasks ?? "# Tasks\n\n## 1. Core\n\n- [x] 1.1 Somar\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const ws: Workspace = (await workspaces.register({ kind: "mono", path: root })).workspace;

  const engine = new FakeEngine();
  engine.abort = async (sessionId) => {
    engine.aborted.push(sessionId);
    const call = engine.prompts.find((p) => p.sessionId === sessionId);
    if (call) engine.emit({ kind: "error", sessionId, name: "MessageAbortedError", message: "aborted" });
  };
  engine.onPrompt = async (call, e) => {
    const output = /Escreva apenas o arquivo `([^`]+)`/.exec(call.text)?.[1];
    const answer = opts.trace?.(call) ?? { items: [] };
    void (async () => {
      await Bun.sleep(5);
      if (answer === "hang") return;
      if (answer === "fail") return e.emit({ kind: "error", sessionId: call.sessionId, name: "ProviderAuthError", message: "sem chave" });
      if (output) writeFileSync(output, typeof answer === "string" ? answer : JSON.stringify(answer));
      e.emit({ kind: "idle", sessionId: call.sessionId });
    })();
  };
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe((e) => void seen.push(e));
  const runner = new AgentRunner(engine, new ChangeSessions(db, engine), events);
  const execs: string[][] = [];
  const environment: TestEnvironment = {
    async exec(_ws, argv, o) {
      execs.push(argv);
      const res = await processRunner.run(argv, { cwd: o.cwd, timeoutMs: o.timeoutMs });
      return { exitCode: res.exitCode, output: `${res.stdout}${res.stderr}`, timedOut: !!res.timedOut };
    },
  };
  const applyRepo = new ApplyRepo(db);
  const repo = new VerificationRepo(db);
  let applyBusy = false;
  const service = new VerificationService(workspaces, runner, environment, repo, applyRepo, events, {
    workDir: mkdtempSync(join(tmpdir(), "studio-verify-work-")),
    applyBusy: () => applyBusy,
    ...(opts.timeoutMs ? { testTimeoutMs: opts.timeoutMs } : {}),
    openspec: adapter,
    ...(opts.git ? { git: opts.git } : {}),
  });
  const verify = async () => {
    await service.run(ws.id, "c");
    await service.settled(ws.id, "c");
    return service.state(ws.id, "c");
  };
  return {
    dir,
    root,
    ws,
    changeDir,
    db,
    engine,
    events: seen,
    execs,
    repo,
    applyRepo,
    service,
    workspaces,
    verify,
    setApplyBusy: (v: boolean) => (applyBusy = v),
    close: () => watcher.close(),
  };
}

/** A trace answer: a valid `teste` evidence of the test project. */
export const evidence = (id: string, line: number, name: string, member = "app") => ({ id, kind: "teste", member, file: "src/soma.test.ts", line, name });
