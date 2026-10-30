import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Workspace } from "@studio/shared";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRunner } from "../apply/environments.ts";
import { snapshot } from "../apply/snapshot.ts";
import { beforeTree, classify, isTestFile, previousTree, prove } from "./proof.ts";
import type { TestEnvironment } from "./service.ts";
import { git } from "./testing.ts";

setDefaultTimeout(60_000);

const dir = mkdtempSync(join(tmpdir(), "studio-proof-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const environment: TestEnvironment = {
  async exec(_ws, argv, o) {
    const res = await processRunner.run(argv, { cwd: o.cwd, timeoutMs: o.timeoutMs });
    return { exitCode: res.exitCode, output: `${res.stdout}${res.stderr}`, timedOut: !!res.timedOut };
  },
};

/** A repo whose `soma` is wrong; the "change" fixes it and adds a test. Returns the trees around it. */
function project(name: string) {
  const member = join(dir, name);
  mkdirSync(join(member, "src"), { recursive: true });
  mkdirSync(join(member, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(member, ".gitignore"), "node_modules/\n");
  writeFileSync(join(member, "node_modules", "dep", "index.js"), "module.exports = 2;\n");
  writeFileSync(join(member, "src", "soma.ts"), "export const soma = (a: number, b: number) => a - b;\n");
  writeFileSync(join(member, "src", "antigo.test.ts"), 'import { test, expect } from "bun:test";\nimport { soma } from "./soma.ts";\ntest("Existe", () => expect(typeof soma).toBe("function"));\n');
  git(member, "init", "-q");
  git(member, "add", "-A");
  git(member, "commit", "-q", "-m", "init");
  const before = snapshot(member);
  // The change: fixes soma, adds a helper and a new test that uses the dependency.
  writeFileSync(join(member, "src", "soma.ts"), "export const soma = (a: number, b: number) => a + b;\n");
  writeFileSync(
    join(member, "src", "soma.test.ts"),
    [
      'import { test, expect } from "bun:test";',
      'import { soma } from "./soma.ts";',
      'const dep = require("dep");',
      'test("Soma certa", () => expect(soma(1, dep)).toBe(3));',
      'test("Sempre falha", () => expect(1).toBe(2));',
      "",
    ].join("\n"),
  );
  // An edit the user staged before the proof: it must stay staged.
  writeFileSync(join(member, "README.md"), "leia\n");
  git(member, "add", "README.md");
  return { member, before };
}

const ws = { id: "w" } as Workspace;
const bun = (name: string) => ["bun", "test", "./src/soma.test.ts", "-t", name];

describe("5.1 prova vermelho para verde", () => {
  test("isTestFile: names and folders of tests", () => {
    for (const p of ["src/a.test.ts", "a.spec.js", "tests/test_x.py", "pkg/x_test.py", "conftest.py", "src/testing/fixtures.ts", "__tests__/a.js"]) {
      expect(isTestFile(p)).toBe(true);
    }
    for (const p of ["src/a.ts", "src/testes.ts", "latest/a.ts"]) expect(isTestFile(p)).toBe(false);
    expect([classify(true, false), classify(true, true), classify(false, false)]).toEqual(["forte", "fraca", "inconclusiva"]);
  });

  test("Prova forte: the new test passes now and fails with the code from before; the tree keeps the tests", async () => {
    const { member, before } = project("forte");
    const prev = previousTree(member, before, snapshot(member));
    expect(git(member, "show", `${prev}:src/soma.ts`)).toContain("a - b");
    expect(git(member, "show", `${prev}:src/soma.test.ts`)).toContain("Soma certa");
    const head = git(member, "rev-parse", "HEAD");
    const staged = git(member, "diff", "--cached", "--name-only");
    const status = git(member, "status", "--porcelain");
    const work = join(dir, "work-forte");
    const proof = await prove({ ws, member, before, argv: bun("Soma certa"), workDir: work, environment, timeoutMs: 30_000 });
    expect(proof).toMatchObject({ status: "concluida", result: "forte" });
    expect(proof.before).toContain("Soma certa");
    // Arquivos do usuário intactos: files, index and HEAD as they were; the copies are gone.
    expect(readFileSync(join(member, "src", "soma.ts"), "utf8")).toContain("a + b");
    expect(git(member, "rev-parse", "HEAD")).toBe(head);
    expect(git(member, "diff", "--cached", "--name-only")).toBe(staged);
    expect(git(member, "status", "--porcelain")).toBe(status);
    expect(existsSync(work)).toBe(false);
  });

  test("Teste que não depende da change: a test that already passed is fraca", async () => {
    const { member, before } = project("fraca");
    const proof = await prove({ ws, member, before, argv: ["bun", "test", "./src/antigo.test.ts", "-t", "Existe"], workDir: join(dir, "work-fraca"), environment, timeoutMs: 30_000 });
    expect(proof).toMatchObject({ status: "concluida", result: "fraca" });
  });

  test("Ambiente que não reproduz: a control that fails makes it inconclusiva", async () => {
    const { member, before } = project("inconclusiva");
    const proof = await prove({ ws, member, before, argv: bun("Sempre falha"), workDir: join(dir, "work-inc"), environment, timeoutMs: 30_000 });
    expect(proof.result).toBe("inconclusiva");
    expect(proof.control).toContain("Sempre falha");
  });

  test("Sem retrato anterior: no task entry for the member, no before tree; the earliest entry wins", () => {
    expect(beforeTree([], "/m")).toBeUndefined();
    const entries = [
      { taskId: "1.2", position: 2, status: "aceita" as const, before: { "/m": "t2" } },
      { taskId: "1.1", position: 1, status: "aceita" as const, before: { "/outro": "x" } },
      { taskId: "1.0", position: 0, status: "aceita" as const, before: { "/m": "t0" } },
    ];
    expect(beforeTree(entries, "/m")).toBe("t0");
    expect(beforeTree(entries.slice(0, 2), "/m")).toBe("t2");
  });

  test("a failure while building the copies is a failed proof, with the message", async () => {
    const { member } = project("falha");
    const proof = await prove({ ws, member, before: "0".repeat(40), argv: bun("x"), workDir: join(dir, "work-falha"), environment, timeoutMs: 30_000 });
    expect(proof.status).toBe("falhou");
    expect(proof.error).toBeTruthy();
  });
});
