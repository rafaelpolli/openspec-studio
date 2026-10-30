import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSnapshots, gitState, restore, snapshot } from "./snapshot.ts";

const base = mkdtempSync(join(tmpdir(), "studio-snap-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function sh(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe" });
  return res.stdout.toString();
}

function repo(name: string, files: Record<string, string>): string {
  const dir = join(base, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  sh(dir, "init", "-q");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** What the user would see in Git: HEAD, the staged index, branches and stash. */
const userGit = (dir: string) => [sh(dir, "rev-parse", "HEAD"), sh(dir, "ls-files", "-s"), sh(dir, "branch"), sh(dir, "stash", "list")];

describe("task snapshots (add-visual-apply D4)", () => {
  test("a task's diff lists what it created, changed and removed, and undo puts it back", () => {
    const dir = repo("basic", { "src/a.ts": "a\n", "src/b.ts": "b\n", ".gitignore": "node_modules\n" });
    // The user's own pending work, before the task.
    writeFileSync(join(dir, "src/a.ts"), "a do usuário\n");
    writeFileSync(join(dir, "notas.txt"), "rascunho\n");
    const status = sh(dir, "status", "--porcelain");
    const git = userGit(dir);

    const before = snapshot(dir);
    writeFileSync(join(dir, "src/a.ts"), "a da task\n");
    unlinkSync(join(dir, "src/b.ts"));
    mkdirSync(join(dir, "src/novo"), { recursive: true });
    writeFileSync(join(dir, "src/novo/c.ts"), "c\n");
    mkdirSync(join(dir, "node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "node_modules/x/i.js"), "ignorado\n");
    const after = snapshot(dir);

    const diff = diffSnapshots(dir, before, after);
    expect(diff.map((f) => [f.path, f.change])).toEqual([
      ["src/a.ts", "modificado"],
      ["src/b.ts", "removido"],
      ["src/novo/c.ts", "criado"],
    ]);
    expect(diff[0]!.patch).toContain("-a do usuário");
    expect(diff[0]!.patch).toContain("+a da task");

    restore(dir, before, diff);
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("a do usuário\n");
    expect(readFileSync(join(dir, "src/b.ts"), "utf8")).toBe("b\n");
    expect(existsSync(join(dir, "src/novo"))).toBe(false);
    expect(readFileSync(join(dir, "notas.txt"), "utf8")).toBe("rascunho\n");
    expect(existsSync(join(dir, "node_modules/x/i.js"))).toBe(true);
    expect(sh(dir, "status", "--porcelain")).toBe(status);
    expect(userGit(dir)).toEqual(git);
  });

  test("a staged change of the user stays staged", () => {
    const dir = repo("staged", { "a.ts": "a\n" });
    writeFileSync(join(dir, "a.ts"), "a staged\n");
    sh(dir, "add", "a.ts");
    const git = userGit(dir);
    const before = snapshot(dir);
    writeFileSync(join(dir, "a.ts"), "a da task\n");
    const diff = diffSnapshots(dir, before, snapshot(dir));
    expect(diff).toHaveLength(1);
    restore(dir, before, diff);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("a staged\n");
    expect(userGit(dir)).toEqual(git);
  });

  test("a member inside a larger repository only sees its own files", () => {
    const top = repo("mono", { "api/a.ts": "a\n", "web/w.ts": "w\n" });
    const api = join(top, "api");
    const before = snapshot(api);
    writeFileSync(join(api, "a.ts"), "a2\n");
    writeFileSync(join(top, "web/w.ts"), "w2\n");
    const diff = diffSnapshots(api, before, snapshot(api));
    expect(diff.map((f) => f.path)).toEqual(["a.ts"]);
    restore(api, before, diff);
    expect(readFileSync(join(api, "a.ts"), "utf8")).toBe("a\n");
    expect(readFileSync(join(top, "web/w.ts"), "utf8")).toBe("w2\n");
  });

  test("an unchanged member has an empty diff", () => {
    const dir = repo("same", { "a.ts": "a\n" });
    expect(diffSnapshots(dir, snapshot(dir), snapshot(dir))).toEqual([]);
  });

  test("gitState tells members without Git and with pending changes apart", () => {
    const clean = repo("clean", { "a.ts": "a\n" });
    expect(gitState(clean)).toEqual({ git: true, dirty: false });
    writeFileSync(join(clean, "b.ts"), "b\n");
    expect(gitState(clean)).toEqual({ git: true, dirty: true });
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(gitState(plain)).toEqual({ git: false, dirty: false });
    expect(gitState(join(base, "missing"))).toEqual({ git: false, dirty: false });
  });
});
