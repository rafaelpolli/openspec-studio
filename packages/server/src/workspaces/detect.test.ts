import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectType, hasCode } from "./detect.ts";

const base = mkdtempSync(join(tmpdir(), "studio-detect-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function folder(name: string, files: Record<string, string>): string {
  const dir = join(base, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

const CONFIG = { "openspec/config.yaml": "schema: spec-driven\n" };

describe("hasCode", () => {
  test("ignores .git, dotfiles, README, LICENSE and openspec/", () => {
    const dir = folder("boiler", {
      ".git/HEAD": "ref",
      ".gitignore": "x",
      "README.md": "# hi",
      "LICENSE": "MIT",
      "openspec/config.yaml": "x",
    });
    expect(hasCode(dir)).toBe(false);
  });

  test("finds a nested source file", () => {
    expect(hasCode(folder("nested", { "src/app/main.ts": "x" }))).toBe(true);
  });
});

describe("detectProjectType", () => {
  test("empty folder is greenfield", () => {
    const dir = folder("empty", { "README.md": "x" });
    expect(detectProjectType(dir, [dir])).toBe("greenfield");
  });

  test("code without OpenSpec is brownfield", () => {
    const dir = folder("legacy", { "src/index.ts": "x" });
    expect(detectProjectType(dir, [dir])).toBe("brownfield");
  });

  test("OpenSpec with specs or changes is inicializado", () => {
    const withSpec = folder("with-spec", { ...CONFIG, "openspec/specs/auth/spec.md": "x", "src/a.ts": "x" });
    expect(detectProjectType(withSpec, [withSpec])).toBe("inicializado");
    const withChange = folder("with-change", { ...CONFIG, "openspec/changes/add-x/proposal.md": "x" });
    expect(detectProjectType(withChange, [withChange])).toBe("inicializado");
  });

  test("freshly initialized greenfield (no code) is inicializado", () => {
    const dir = folder("fresh", { ...CONFIG, "openspec/specs/.gitkeep": "", "openspec/changes/archive/.gitkeep": "" });
    expect(detectProjectType(dir, [dir])).toBe("inicializado");
  });

  test("initialized but without specs and with code is still brownfield", () => {
    const dir = folder("init-legacy", { ...CONFIG, "openspec/specs/.gitkeep": "", "lib/x.py": "x" });
    expect(detectProjectType(dir, [dir])).toBe("brownfield");
  });

  test("a fresh store with code members is brownfield", () => {
    const store = folder("store", CONFIG);
    const api = folder("api", { "src/server.go": "x" });
    expect(detectProjectType(store, [api])).toBe("brownfield");
  });
});
