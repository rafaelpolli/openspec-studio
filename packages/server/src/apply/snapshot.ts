import type { FileChange } from "@studio/shared";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

/**
 * Per-task snapshots of a member's working tree, taken with a temporary Git index so the
 * user's index, HEAD and branches are never touched and no commit is made (add-visual-apply
 * D4, spike Apply 1.2). A snapshot is a tree object of the files as they are, pending
 * changes included; `.gitignore`d files are left out.
 */

function git(cwd: string, args: string[], env?: Record<string, string>) {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return { ok: res.exitCode === 0, out: res.stdout.toString(), err: res.stderr.toString() };
}

/** Runs `fn` with a throwaway index, seeded from the user's so unchanged files are not rehashed. */
function withTempIndex<T>(member: string, fn: (env: Record<string, string>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "studio-index-"));
  try {
    const index = join(dir, "index");
    const own = git(member, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).out.trim();
    if (own && existsSync(own)) copyFileSync(own, index);
    return fn({ GIT_INDEX_FILE: index });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface MemberGitState {
  git: boolean;
  /** Uncommitted changes (staged, unstaged or untracked) inside the member. */
  dirty: boolean;
}

export function gitState(member: string): MemberGitState {
  let inside;
  try {
    inside = git(member, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { git: false, dirty: false }; // the folder does not exist
  }
  if (!inside.ok || inside.out.trim() !== "true") return { git: false, dirty: false };
  const status = git(member, ["status", "--porcelain", "--", "."]);
  return { git: true, dirty: status.out.trim() !== "" };
}

/**
 * The member's files as they are now, as a tree id. `exclude` lists member-relative folders
 * left out of the tree (add-change-verification D7 leaves out the root's `openspec/`).
 */
export function snapshot(member: string, exclude: readonly string[] = []): string {
  return withTempIndex(member, (env) => {
    if (exclude.length > 0) {
      // The seed index has those files; they must not stay in the tree either.
      git(member, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...exclude], env);
    }
    const add = git(member, ["add", "-A", "--", ".", ...exclude.map((e) => `:(exclude)${e}`)], env);
    if (!add.ok) throw new Error(`git add falhou em ${member}: ${add.err.trim()}`);
    const tree = git(member, ["write-tree"], env);
    if (!tree.ok) throw new Error(`git write-tree falhou em ${member}: ${tree.err.trim()}`);
    return tree.out.trim();
  });
}

/** The member's path inside its repository, as a pathspec (`.` for the repository itself). */
function prefix(member: string): string {
  return git(member, ["rev-parse", "--show-prefix"]).out.trim() || ".";
}

const CHANGE: Record<string, FileChange["change"]> = { A: "criado", M: "modificado", D: "removido", T: "modificado" };

/** What changed in the member between two snapshots. */
export function diffSnapshots(member: string, before: string, after: string): FileChange[] {
  if (before === after) return [];
  const top = git(member, ["rev-parse", "--show-toplevel"]).out.trim();
  const spec = prefix(member);
  const list = git(top, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", before, after, "--", spec]);
  if (!list.ok) throw new Error(`git diff-tree falhou em ${member}: ${list.err.trim()}`);
  const fields = list.out.split("\0").filter(Boolean);
  const out: FileChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const fromTop = fields[i + 1]!;
    const patch = git(top, ["diff", "--no-renames", "--no-color", before, after, "--", fromTop]).out;
    out.push({ path: relative(member, join(top, fromTop)), change: CHANGE[fields[i]!] ?? "modificado", patch });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Top of the member's repository. */
export function repoTop(member: string): string {
  return git(member, ["rev-parse", "--show-toplevel"]).out.trim();
}

/** Path → blob of the given top-relative paths in a tree. */
function blobs(top: string, tree: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of git(top, ["ls-tree", "-z", tree, "--", ...paths]).out.split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t");
    out.set(path!, meta!.split(" ")[2]!);
  }
  return out;
}

/**
 * Files the task changed that already had uncommitted changes before it: their blob in the
 * `before` snapshot is not the one in HEAD, so a commit of the task would carry the user's
 * earlier changes too (add-git-commits D3). Computed against the current HEAD, which may
 * have moved since the task ran.
 */
export function dirtyBefore(member: string, before: string, changes: readonly FileChange[]): string[] {
  const modified = changes.filter((c) => c.change === "modificado");
  if (modified.length === 0) return [];
  const top = repoTop(member);
  const paths = modified.map((c) => relative(top, join(member, c.path)));
  const head = git(top, ["rev-parse", "--verify", "-q", "HEAD"]).ok ? blobs(top, "HEAD", paths) : new Map<string, string>();
  const prev = blobs(top, before, paths);
  return modified.filter((_, i) => prev.get(paths[i]!) !== head.get(paths[i]!)).map((c) => c.path);
}

/**
 * Puts the files a task changed back as they were in `before`: created files are removed,
 * changed and removed ones are restored. Nothing else in the member is touched.
 */
export function restore(member: string, before: string, changes: readonly FileChange[]): void {
  const created = changes.filter((c) => c.change === "criado");
  const others = changes.filter((c) => c.change !== "criado").map((c) => c.path);
  for (const c of created) {
    rmSync(join(member, c.path), { force: true });
    // Folders the task created for its files go too (Git does not keep empty folders).
    for (let dir = dirname(join(member, c.path)); dir !== member && relative(member, dir) && !relative(member, dir).startsWith(".."); dir = dirname(dir)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    }
  }
  if (others.length === 0) return;
  withTempIndex(member, (env) => {
    const read = git(member, ["read-tree", before], env);
    if (!read.ok) throw new Error(`git read-tree falhou em ${member}: ${read.err.trim()}`);
    const checkout = git(member, ["checkout-index", "-f", "--", ...others], env);
    if (!checkout.ok) throw new Error(`git checkout-index falhou em ${member}: ${checkout.err.trim()}`);
  });
}
