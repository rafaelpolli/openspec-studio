import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStateError, type GitClient } from "./exec.ts";
import { repoState } from "./repo.ts";

/**
 * Builds a commit in a throwaway index that starts from HEAD (or empty, in a repo without
 * commits), so the user's stage is never what gets committed. After the commit, the
 * committed paths are reset in the real index to match the new HEAD; other staged paths
 * stay as the user left them (D1).
 */
async function withIndexFromHead(
  git: GitClient,
  top: string,
  fill: (env: Record<string, string>) => Promise<void>,
  commit: (env: Record<string, string>) => Promise<void>,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "studio-commit-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    if ((await git.run(top, ["rev-parse", "--verify", "-q", "HEAD"])).ok) await git.must(top, ["read-tree", "HEAD"], { env });
    await fill(env);
    await commit(env);
    return (await git.must(top, ["rev-parse", "HEAD"])).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const noVerifyArg = (noVerify?: boolean) => (noVerify ? ["--no-verify"] : []);

/** Commits every uncommitted change inside the area, and nothing outside it (spec: "Commitar pendências"). */
export async function commitPending(git: GitClient, path: string, opts: { message: string; noVerify?: boolean }): Promise<string> {
  const st = await repoState(git, path);
  if (!st.git) throw new GitStateError(`${path} não é um repositório Git`);
  if (st.pending === 0) throw new GitStateError("não há alterações para commitar");
  const sha = await withIndexFromHead(
    git,
    st.top!,
    (env) => git.must(path, ["add", "-A", "--", "."], { env }).then(() => {}),
    (env) => git.commit(path, [...noVerifyArg(opts.noVerify), "-m", opts.message], env),
  );
  await git.run(path, ["reset", "-q", "--", "."]);
  return sha;
}

/** One file of a task's commit, relative to the top of the repository. */
export interface TreeFile {
  path: string;
  /** Removed by the task: the commit removes it too. */
  removed?: boolean;
  /** Snapshot to take the content from, when not the commit's `after`. */
  tree?: string;
}

/**
 * The commit of a task (D1): each file takes the content it has in the task's `after`
 * snapshot, not the working tree, so later edits stay uncommitted. `fromWorkTree` files
 * (the change's tasks.md, marked on accept) take their working-tree content.
 */
export async function commitTree(
  git: GitClient,
  top: string,
  opts: { after?: string; files: TreeFile[]; fromWorkTree?: string[]; message: string; noVerify?: boolean },
): Promise<string> {
  const paths = [...opts.files.map((f) => f.path), ...(opts.fromWorkTree ?? [])];
  const sha = await withIndexFromHead(
    git,
    top,
    async (env) => {
      for (const f of opts.files) {
        if (f.removed) {
          await git.must(top, ["update-index", "--force-remove", "--", f.path], { env });
          continue;
        }
        const tree = f.tree ?? opts.after;
        if (!tree) throw new GitStateError(`${f.path} não tem retrato de onde tirar o conteúdo`);
        const entry = (await git.must(top, ["ls-tree", "-z", tree, "--", f.path])).split("\0")[0] ?? "";
        const [meta] = entry.split("\t");
        const [mode, , blob] = (meta ?? "").split(" ");
        if (!mode || !blob) throw new GitStateError(`${f.path} não está no retrato da task`);
        await git.must(top, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${f.path}`], { env });
      }
      if (opts.fromWorkTree?.length) await git.must(top, ["update-index", "--add", "--", ...opts.fromWorkTree], { env });
    },
    (env) => git.commit(top, [...noVerifyArg(opts.noVerify), "-m", opts.message], env),
  );
  await git.run(top, ["reset", "-q", "--", ...paths]);
  return sha;
}
