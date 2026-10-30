import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { areaState, clearIdentity, identity, repoState, setIdentity } from "./repo.ts";
import { gitSandbox } from "./testing.ts";

const { dir, home, client, sh, globalIdentity, folder } = gitSandbox();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("1.1 estado do Git por membro", () => {
  test("a clean member, a dirty one and one without Git", async () => {
    const clean = folder("limpo", { "a.ts": "a\n" });
    const dirty = folder("sujo", { "a.ts": "a\n", "b.ts": "b\n" });
    writeFileSync(join(dirty, "a.ts"), "mudou\n");
    writeFileSync(join(dirty, "c.ts"), "c\n");
    rmSync(join(dirty, "b.ts"));
    const plain = folder("legado", { "a.ts": "a\n" }, { git: false });

    expect(await repoState(client, clean)).toEqual({ git: true, top: clean, branch: "main", nested: false, pending: 0 });
    expect(await repoState(client, dirty)).toMatchObject({ git: true, pending: 3 });
    expect(await repoState(client, plain)).toEqual({ git: false, pending: 0 });
    expect(await repoState(client, join(dir, "nao-existe"))).toEqual({ git: false, pending: 0 });
  });

  test("Membro dentro de outro repo: part of it, counting only its own folder", async () => {
    const mono = folder("mono", { "pkg/api/a.ts": "a\n", "pkg/web/w.ts": "w\n" });
    writeFileSync(join(mono, "pkg/api/a.ts"), "mudou\n");
    writeFileSync(join(mono, "pkg/web/w.ts"), "mudou\n");
    writeFileSync(join(mono, "pkg/web/x.ts"), "novo\n");
    const api = await repoState(client, join(mono, "pkg/api"));
    expect(api).toMatchObject({ git: true, top: mono, nested: true, pending: 1 });
    expect((await repoState(client, join(mono, "pkg/web"))).pending).toBe(2);
  });
});

describe("1.1 identidade do Git por repo", () => {
  test("Identidade global, then the repo's own, and back; the global config never changes", async () => {
    globalIdentity("Global", "g@x");
    const gitconfig = readFileSync(join(home, ".gitconfig"), "utf8");
    const repo = folder("ident", { "a.ts": "a\n" });
    const other = folder("ident-outro", { "a.ts": "a\n" });

    expect(await identity(client, repo)).toEqual({ name: "Global", email: "g@x", nameScope: "global", emailScope: "global" });

    await setIdentity(client, repo, "Ana", "ana@empresa.com");
    expect(await identity(client, repo)).toEqual({ name: "Ana", email: "ana@empresa.com", nameScope: "local", emailScope: "local" });
    expect((await identity(client, other)).name).toBe("Global");
    expect(sh(repo, "config", "--local", "user.email").trim()).toBe("ana@empresa.com");
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe(gitconfig);

    await clearIdentity(client, repo);
    expect((await identity(client, repo)).nameScope).toBe("global");
    await clearIdentity(client, repo); // nothing left to remove
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe(gitconfig);
  });

  test("a folder without Git shows the global identity but cannot get its own", async () => {
    const plain = folder("ident-sem-git", { "a.ts": "a\n" }, { git: false });
    expect((await areaState(client, { name: "legado", path: plain })).identity.nameScope).toBe("global");
    expect(setIdentity(client, plain, "Ana", "a@a")).rejects.toThrow("não é um repositório Git");
  });
});
