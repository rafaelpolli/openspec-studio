import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRunner, escapeRegex, testCommand } from "./runners.ts";

const dir = mkdtempSync(join(tmpdir(), "studio-runners-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function member(name: string, files: Record<string, string | object>): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(path, file), typeof content === "string" ? content : JSON.stringify(content));
  }
  return path;
}

describe("2.1 runners por modelo de comando", () => {
  test("bun: by the test script or by bun.lock; the name is filtered as an escaped regex", () => {
    const byScript = member("bun-script", { "package.json": { scripts: { test: "bun test --timeout 60000" } } });
    expect(detectRunner(byScript, "src/a.test.ts")).toBe("bun");
    const byLock = member("bun-lock", { "package.json": {}, "bun.lock": "" });
    expect(testCommand(byLock, "src/a.test.ts", "Hook recusa (pre-commit) + saída.")).toEqual({
      kind: "bun",
      argv: ["bun", "test", "./src/a.test.ts", "-t", "Hook recusa \\(pre-commit\\) \\+ saída\\."],
    });
  });

  test("vitest and jest win over bun.lock, and run through the lockfile's exec", () => {
    const vitest = member("vitest", { "package.json": { devDependencies: { vitest: "^2" } }, "pnpm-lock.yaml": "" });
    expect(testCommand(vitest, "a.test.ts", "x")).toEqual({ kind: "vitest", argv: ["pnpm", "exec", "vitest", "run", "a.test.ts", "-t", "x"] });
    const jest = member("jest", { "package.json": { dependencies: { jest: "^29" } }, "bun.lock": "" });
    expect(testCommand(jest, "a.test.js", "y")).toEqual({ kind: "jest", argv: ["bunx", "jest", "a.test.js", "-t", "y"] });
    const npx = member("jest-npm", { "package.json": { devDependencies: { jest: "^29" } } });
    expect(testCommand(npx, "a.test.js", "y").argv?.[0]).toBe("npx");
  });

  test("pytest: only for .py files of a member with a pytest marker, by node id", () => {
    const py = member("py", { "pyproject.toml": "[tool.pytest.ini_options]\n" });
    expect(testCommand(py, "tests/test_a.py", "test_login")).toEqual({
      kind: "pytest",
      argv: ["python3", "-m", "pytest", "tests/test_a.py::test_login"],
    });
    expect(detectRunner(member("py-solto", {}), "test_a.py")).toBeUndefined();
  });

  test("Runner desconhecido: no argv, with the member's test script as a hint", () => {
    const mocha = member("mocha", { "package.json": { scripts: { test: "mocha" } } });
    const cmd = testCommand(mocha, "test/a.js", "z");
    expect(cmd.argv).toBeUndefined();
    expect(cmd.reason).toBe("runner desconhecido (o script de teste do membro é `mocha`): confira este cenário manualmente");
    expect(testCommand(member("vazio", {}), "a.go", "z").reason).toStartWith("runner desconhecido:");
  });

  test("escapeRegex matches the text literally", () => {
    const name = "a.b*c(d)[e]{f}|g^h$i?j+k\\l/m";
    expect(new RegExp(escapeRegex(name)).test(`prefixo ${name} sufixo`)).toBe(true);
    expect(new RegExp(escapeRegex("a.b")).test("axb")).toBe(false);
  });
});
