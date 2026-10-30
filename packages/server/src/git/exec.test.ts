import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitActionError, GitClient } from "./exec.ts";
import { gitSandbox } from "./testing.ts";

const { dir, env, client, sh, folder } = gitSandbox("studio-git-exec-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A repo with one staged change, ready for `git commit`. */
function staged(name: string) {
  const repo = folder(name, { "a.ts": "a\n" });
  sh(repo, "config", "user.name", "Ana");
  sh(repo, "config", "user.email", "ana@x");
  writeFileSync(join(repo, "a.ts"), "mudou\n");
  sh(repo, "add", "a.ts");
  return { repo, head: sh(repo, "rev-parse", "HEAD") };
}

async function failure(p: Promise<unknown>): Promise<GitActionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GitActionError) return err;
    throw err;
  }
  throw new Error("o commit não falhou");
}

describe("2.1 falhas do Git", () => {
  test("a commit that works", async () => {
    const { repo, head } = staged("ok");
    await client.commit(repo, ["-m", "mudança"]);
    expect(sh(repo, "rev-parse", "HEAD")).not.toBe(head);
    expect(sh(repo, "log", "-1", "--format=%an %s").trim()).toBe("Ana mudança");
  });

  test("Sem identidade: kind identidade, and no commit", async () => {
    const { repo, head } = staged("sem-identidade");
    sh(repo, "config", "--unset", "user.name");
    sh(repo, "config", "--unset", "user.email");
    sh(repo, "config", "user.useConfigOnly", "true");
    const err = await failure(client.commit(repo, ["-m", "x"]));
    expect(err.kind).toBe("identidade");
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
  });

  test("Hook recusa o commit: kind hook with its output; --no-verify then works", async () => {
    const { repo, head } = staged("hook");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint: 2 erros' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const err = await failure(client.commit(repo, ["-m", "x"]));
    expect(err.kind).toBe("hook");
    expect(err.output).toContain("lint: 2 erros");
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
    await client.commit(repo, ["--no-verify", "-m", "x"]);
    expect(sh(repo, "rev-parse", "HEAD")).not.toBe(head);
  });

  test("Assinatura que pede senha: the timeout ends it as assinatura, with no commit", async () => {
    const { repo, head } = staged("assinatura");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // Stands in for gpg waiting on a passphrase nobody will type.
    writeFileSync(join(bin, "gpg-espera"), "#!/bin/sh\nsleep 30\n");
    chmodSync(join(bin, "gpg-espera"), 0o755);
    sh(repo, "config", "commit.gpgsign", "true");
    sh(repo, "config", "gpg.program", join(bin, "gpg-espera"));
    const quick = new GitClient({ env, commitTimeoutMs: 1500 });
    const started = Date.now();
    const err = await failure(quick.commit(repo, ["-m", "x"]));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(err.kind).toBe("assinatura");
    expect(err.message).toContain("pelo terminal");
    expect(sh(repo, "rev-parse", "HEAD")).toBe(head);
  });

  test("a signer that fails outright is assinatura too", async () => {
    const { repo } = staged("assinatura-falha");
    sh(repo, "config", "commit.gpgsign", "true");
    sh(repo, "config", "gpg.program", "/bin/false");
    expect((await failure(client.commit(repo, ["-m", "x"]))).kind).toBe("assinatura");
  });
});
