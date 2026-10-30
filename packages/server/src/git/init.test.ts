import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitActionError } from "./exec.ts";
import { init, previewInit } from "./init.ts";
import { gitSandbox } from "./testing.ts";

const { dir, client, sh, globalIdentity, folder } = gitSandbox("studio-git-init-");
globalIdentity("Global", "g@x");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const committed = (repo: string) => sh(repo, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n").sort();

describe("3.1 inicializar Git com commit inicial", () => {
  test("Pré-visualização: node_modules and dist ignored, nothing created in the folder", async () => {
    const path = folder("legado", { "src/a.ts": "aaaa\n", "node_modules/x/i.js": "x\n", "dist/out.js": "o\n", "README.md": "r\n" }, { git: false });
    const before = readdirSync(path).sort();
    const p = await previewInit(client, path);
    expect(p.existing).toBe(false);
    expect(p.additions).toEqual(expect.arrayContaining(["node_modules/", "dist/", ".env", ".env.*"]));
    expect(p.additions).not.toContain("build/");
    expect(p.gitignore).toStartWith("node_modules/\ndist/\n");
    expect(p.files.map((f) => f.path)).toEqual([".gitignore", "README.md", "src/a.ts"]);
    expect(p.fileCount).toBe(3);
    expect(p.totalBytes).toBe(Buffer.byteLength(p.gitignore) + 2 + 5);
    expect(readdirSync(path).sort()).toEqual(before);
  });

  test("Arquivo de segredos: flagged and left out; an edited .gitignore that keeps it in is flagged as included", async () => {
    const path = folder("segredos", { "src/a.ts": "a\n", ".env.local": "TOKEN=1\n", "certs/server.pem": "k\n" }, { git: false });
    const p = await previewInit(client, path);
    expect(p.secrets).toEqual([
      { path: ".env.local", ignored: true },
      { path: "certs/server.pem", ignored: true },
    ]);
    expect(p.files.map((f) => f.path)).not.toContain(".env.local");
    const edited = await previewInit(client, path, "*.pem\n");
    expect(edited.secrets).toContainEqual({ path: ".env.local", ignored: false });
  });

  test("Confirmar: the initial commit has exactly the previewed files, and the folder is clean", async () => {
    const path = folder("confirmar", { "src/a.ts": "a\n", ".env": "S=1\n", "node_modules/m.js": "m\n" }, { git: false });
    const p = await previewInit(client, path);
    await init(client, path, { gitignore: p.gitignore, message: "Estado inicial" });
    expect(committed(path)).toEqual(p.files.map((f) => f.path));
    expect(sh(path, "status", "--porcelain")).toBe("");
    expect(sh(path, "log", "--format=%an %s").trim()).toBe("Global Estado inicial");
  });

  test(".gitignore existente: kept as it is, with the proposed lines only appended", async () => {
    const path = folder("existente", { ".gitignore": "logs/\n", "src/a.ts": "a\n", "logs/x.log": "l\n" }, { git: false });
    const p = await previewInit(client, path);
    expect(p.existing).toBe(true);
    expect(p.additions).toContain(".env");
    expect(p.gitignore).toStartWith("logs/\n.env\n");
    // The user may refuse the additions: the existing file alone is fine.
    await init(client, path, { gitignore: "logs/\n", message: "inicial" });
    expect(readFileSync(join(path, ".gitignore"), "utf8")).toBe("logs/\n");
    expect(committed(path)).toEqual([".gitignore", "src/a.ts"]);
  });

  test("replacing the existing .gitignore is refused", async () => {
    const path = folder("substituir", { ".gitignore": "logs/\n", "a.ts": "a\n" }, { git: false });
    expect(previewInit(client, path, ".env\n")).rejects.toThrow("precisa ser mantido");
    expect(init(client, path, { gitignore: ".env\n", message: "x" })).rejects.toThrow("precisa ser mantido");
    expect(existsSync(join(path, ".git"))).toBe(false);
  });

  test("Pasta já dentro de um repo: refused, for a repo and for a subfolder of one", async () => {
    const repo = folder("ja-repo", { "pkg/a.ts": "a\n" });
    expect(previewInit(client, repo)).rejects.toThrow("já está dentro de um repositório Git");
    expect(init(client, join(repo, "pkg"), { gitignore: "", message: "x" })).rejects.toThrow("já está dentro");
    expect(existsSync(join(repo, "pkg", ".git"))).toBe(false);
  });

  test("a failed commit leaves the folder as it was", async () => {
    const path = folder("falha", { ".gitignore": "logs/\n", "a.ts": "a\n" }, { git: false });
    const hooks = join(dir, "hooks-falha");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    sh(dir, "config", "--global", "core.hooksPath", hooks);
    try {
      const err = await init(client, path, { gitignore: "logs/\n.env\n", message: "x" }).catch((e) => e);
      expect(err).toBeInstanceOf(GitActionError);
      expect((err as GitActionError).kind).toBe("hook");
      expect(existsSync(join(path, ".git"))).toBe(false);
      expect(readFileSync(join(path, ".gitignore"), "utf8")).toBe("logs/\n");
      // "Commitar sem hooks" gets through.
      await init(client, path, { gitignore: "logs/\n.env\n", message: "x", noVerify: true });
      expect(committed(path)).toEqual([".gitignore", "a.ts"]);
    } finally {
      sh(dir, "config", "--global", "--unset", "core.hooksPath");
    }
  });
});

describe("3.1 identidade no init", () => {
  test("Sem identidade: the init can set the new repo's own identity before the initial commit", async () => {
    const path = folder("init-identidade", { "a.ts": "a\n" }, { git: false });
    await init(client, path, { gitignore: ".env\n", message: "inicial", identity: { name: "Ana", email: "ana@x" } });
    expect(sh(path, "log", "--format=%an <%ae>").trim()).toBe("Ana <ana@x>");
    expect(sh(path, "config", "--local", "user.name").trim()).toBe("Ana");
  });
});
