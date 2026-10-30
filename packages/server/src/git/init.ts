import type { InitPreview } from "@studio/shared";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStateError, type GitClient } from "./exec.ts";
import { repoState } from "./repo.ts";

/** Names that suggest secrets: always proposed for the `.gitignore` (spec: "Proteção contra segredos"). */
export const SECRET_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*"];

/** Folders that are generated or installed, proposed when they exist at the top of the folder. */
const GENERATED = ["node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target"];

const MAX_FILES = 500;

const normalize = (line: string) => line.trim().replace(/^\//, "").replace(/\/$/, "");

function proposals(path: string): string[] {
  const dirs = GENERATED.filter((d) => existsSync(join(path, d)) && lstatSync(join(path, d)).isDirectory()).map((d) => `${d}/`);
  return [...dirs, ...SECRET_PATTERNS];
}

function readGitignore(path: string): string | null {
  const file = join(path, ".gitignore");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** Checks the folder can get its own repo: it exists and is not inside one (D4). */
async function requireNoRepo(git: GitClient, path: string): Promise<void> {
  if (!existsSync(path)) throw new GitStateError(`${path} não existe`);
  if ((await repoState(git, path)).git || existsSync(join(path, ".git"))) {
    throw new GitStateError(`${path} já está dentro de um repositório Git`);
  }
}

/** The existing `.gitignore` stays as it is: the text may only add lines after it. */
function checkKeepsExisting(existing: string | null, text: string): void {
  if (existing !== null && !text.startsWith(existing)) {
    throw new GitStateError("o .gitignore que já existe precisa ser mantido: só é possível acrescentar linhas a ele");
  }
}

/**
 * What an init would commit, worked out with a throwaway Git dir so nothing is created in
 * the folder: the proposed `.gitignore`, the files and their size, and the secret-looking
 * names (D4).
 */
export async function previewInit(git: GitClient, path: string, gitignore?: string): Promise<InitPreview> {
  await requireNoRepo(git, path);
  const existing = readGitignore(path);
  const have = new Set((existing ?? "").split("\n").map(normalize).filter(Boolean));
  const additions = proposals(path).filter((line) => !have.has(normalize(line)));
  const suggested =
    existing === null
      ? `${additions.join("\n")}\n`
      : additions.length === 0
        ? existing
        : `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${additions.join("\n")}\n`;
  const text = gitignore ?? suggested;
  checkKeepsExisting(existing, text);

  const tmp = mkdtempSync(join(tmpdir(), "studio-init-"));
  try {
    await git.must(tmp, ["init", "-q", "repo"]);
    const excludes = join(tmp, "gitignore");
    writeFileSync(excludes, text);
    const gitDir = `--git-dir=${join(tmp, "repo", ".git")}`;
    const tree = `--work-tree=${path}`;
    const list = await git.must(path, [gitDir, tree, "ls-files", "--others", "--exclude-standard", "-z", "-X", excludes]);
    // The proposed .gitignore itself goes into the commit too.
    const paths = [...new Set([...list.split("\0").filter(Boolean), ...(text.trim() ? [".gitignore"] : [])])].sort();
    const secretArgs = SECRET_PATTERNS.flatMap((p) => ["-x", p]);
    const secretList = await git.must(path, [gitDir, tree, "ls-files", "--others", "--ignored", "-z", ...secretArgs]);
    const included = new Set(paths);
    const files = paths.map((p) => {
      const full = join(path, p);
      return { path: p, size: existsSync(full) ? lstatSync(full).size : Buffer.byteLength(text) };
    });
    return {
      gitignore: text,
      existing: existing !== null,
      additions,
      files: files.slice(0, MAX_FILES),
      fileCount: files.length,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
      secrets: secretList
        .split("\0")
        .filter(Boolean)
        .sort()
        .map((p) => ({ path: p, ignored: !included.has(p) })),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Creates the repo with the `.gitignore` and the initial commit. If anything fails the
 * folder is left as it was: the new `.git` goes and the `.gitignore` is put back (D4).
 */
export async function init(
  git: GitClient,
  path: string,
  opts: { gitignore: string; message: string; noVerify?: boolean; identity?: { name: string; email: string } },
): Promise<void> {
  await requireNoRepo(git, path);
  const existing = readGitignore(path);
  checkKeepsExisting(existing, opts.gitignore);
  const gitignoreFile = join(path, ".gitignore");
  try {
    await git.must(path, ["init", "-q"]);
    if (opts.identity) {
      await git.must(path, ["config", "--local", "user.name", opts.identity.name]);
      await git.must(path, ["config", "--local", "user.email", opts.identity.email]);
    }
    if (opts.gitignore !== (existing ?? "") && opts.gitignore.trim()) writeFileSync(gitignoreFile, opts.gitignore);
    await git.must(path, ["add", "-A"]);
    await git.commit(path, [...(opts.noVerify ? ["--no-verify"] : []), "-m", opts.message]);
  } catch (err) {
    rmSync(join(path, ".git"), { recursive: true, force: true });
    if (existing === null) rmSync(gitignoreFile, { force: true });
    else writeFileSync(gitignoreFile, existing);
    throw err;
  }
}
