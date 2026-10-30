import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitState, snapshot } from "../apply/snapshot.ts";
import { commitPending, commitTree } from "./commit.ts";
import { gitSandbox } from "./testing.ts";

const { dir, client, sh, globalIdentity, folder } = gitSandbox("studio-git-commit-");
globalIdentity("Global", "g@x");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lastCommit = (repo: string) => sh(repo, "show", "--name-status", "--format=%s", "HEAD").trim().split("\n").filter(Boolean);

describe("4.1 commitar pendências", () => {
  test("Limpar antes do apply: every pending file of the member, and the warning goes away", async () => {
    const repo = folder("web", { "a.ts": "a\n", "b.ts": "b\n" });
    writeFileSync(join(repo, "a.ts"), "mudou\n");
    rmSync(join(repo, "b.ts"));
    writeFileSync(join(repo, "c.ts"), "novo\n");
    expect(gitState(repo).dirty).toBe(true);
    await commitPending(client, repo, { message: "ajustes manuais" });
    expect(lastCommit(repo)).toEqual(["ajustes manuais", "M\ta.ts", "D\tb.ts", "A\tc.ts"]);
    expect(gitState(repo).dirty).toBe(false);
  });

  test("a member inside a larger repo commits only its folder; the user's stage elsewhere is kept", async () => {
    const mono = folder("mono", { "api/a.ts": "a\n", "web/w.ts": "w\n", "docs/d.md": "d\n" });
    writeFileSync(join(mono, "api/a.ts"), "mudou\n");
    writeFileSync(join(mono, "web/w.ts"), "mudou\n");
    writeFileSync(join(mono, "docs/d.md"), "staged\n");
    sh(mono, "add", "docs/d.md");
    await commitPending(client, join(mono, "api"), { message: "api" });
    expect(lastCommit(mono)).toEqual(["api", "M\tapi/a.ts"]);
    expect(sh(mono, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M web/w.ts", "M  docs/d.md"]);
  });

  test("a clean member or one without Git is refused", async () => {
    const clean = folder("limpo", { "a.ts": "a\n" });
    expect(commitPending(client, clean, { message: "x" })).rejects.toThrow("não há alterações");
    const plain = join(dir, "sem-git");
    mkdirSync(plain);
    expect(commitPending(client, plain, { message: "x" })).rejects.toThrow("não é um repositório Git");
  });
});

describe("5.2 commit de uma task a partir do retrato", () => {
  test("Conteúdo exato da task: the snapshot's content, even after a later edit; removals included; other stage kept", async () => {
    const repo = folder("task", { "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" });
    writeFileSync(join(repo, "c.ts"), "staged pelo usuário\n");
    sh(repo, "add", "c.ts");
    // The task: changes a.ts, removes b.ts, creates d.ts.
    writeFileSync(join(repo, "a.ts"), "a da task\n");
    rmSync(join(repo, "b.ts"));
    writeFileSync(join(repo, "d.ts"), "d da task\n");
    const after = snapshot(repo);
    // The user edits a.ts after the task.
    writeFileSync(join(repo, "a.ts"), "a do usuário depois\n");

    await commitTree(client, repo, {
      after,
      files: [{ path: "a.ts" }, { path: "b.ts", removed: true }, { path: "d.ts" }],
      message: "c: 1.1 Fazer",
    });
    expect(lastCommit(repo)).toEqual(["c: 1.1 Fazer", "M\ta.ts", "D\tb.ts", "A\td.ts"]);
    expect(sh(repo, "show", "HEAD:a.ts")).toBe("a da task\n");
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("a do usuário depois\n");
    // a.ts still differs from HEAD (the user's edit); c.ts is still staged; nothing else is.
    expect(sh(repo, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M a.ts", "M  c.ts"]);
  });

  test("a working-tree file (the marked tasks.md) goes with the snapshot's files", async () => {
    const repo = folder("tasks-md", { "src/x.ts": "x\n", "openspec/changes/c/tasks.md": "- [ ] 1.1 Fazer\n" });
    writeFileSync(join(repo, "src/x.ts"), "x da task\n");
    const after = snapshot(repo);
    writeFileSync(join(repo, "openspec/changes/c/tasks.md"), "- [x] 1.1 Fazer\n");
    await commitTree(client, repo, { after, files: [{ path: "src/x.ts" }], fromWorkTree: ["openspec/changes/c/tasks.md"], message: "m" });
    expect(lastCommit(repo)).toEqual(["m", "M\topenspec/changes/c/tasks.md", "M\tsrc/x.ts"]);
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });

  test("a repo without commits gets its first commit with only the task's files", async () => {
    const repo = join(dir, "vazio");
    mkdirSync(repo);
    sh(repo, "init", "-q");
    writeFileSync(join(repo, "anterior.txt"), "do usuário\n");
    writeFileSync(join(repo, "novo.ts"), "da task\n");
    const after = snapshot(repo);
    await commitTree(client, repo, { after, files: [{ path: "novo.ts" }], message: "primeiro" });
    expect(sh(repo, "ls-tree", "--name-only", "HEAD").trim()).toBe("novo.ts");
    expect(sh(repo, "status", "--porcelain").trim()).toBe("?? anterior.txt");
  });

  test("an area that is a subfolder commits only its own files", async () => {
    const mono = folder("sub", { "api/a.ts": "a\n", "web/w.ts": "w\n" });
    writeFileSync(join(mono, "api/a.ts"), "a da task\n");
    writeFileSync(join(mono, "web/w.ts"), "w do usuário\n");
    const after = snapshot(join(mono, "api"));
    await commitTree(client, mono, { after, files: [{ path: "api/a.ts" }], message: "api" });
    expect(lastCommit(mono)).toEqual(["api", "M\tapi/a.ts"]);
    expect(sh(mono, "status", "--porcelain").trim()).toBe("M web/w.ts");
  });
});
