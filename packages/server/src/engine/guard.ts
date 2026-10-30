import type { WriteViolation } from "@studio/shared";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** Folders never scanned: VCS metadata and dependency trees. */
const SKIP = new Set([".git", "node_modules"]);

type Snapshot = Map<string, string>;

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function scan(dir: string, exclude: string, out: Snapshot): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (isWithin(exclude, path)) continue;
    if (entry.isDirectory()) scan(path, exclude, out);
    else {
      try {
        const st = lstatSync(path);
        out.set(path, `${st.mtimeMs}:${st.size}`);
      } catch {
        // vanished while scanning
      }
    }
  }
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: res.exitCode === 0, out: res.stdout.toString() };
}

/** True when `dir` is the top of a Git work tree with no pending changes. */
function isCleanRepo(dir: string): boolean {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || top.out.trim() !== dir) return false;
  const status = git(dir, ["status", "--porcelain"]);
  return status.ok && status.out.trim() === "";
}

/**
 * Detects writes outside the OpenSpec root during an agent run, independently of the
 * engine's own permissions (design D8): snapshot (path, mtime, size) of every member
 * before the run, compare after, and revert in members that were clean Git repos.
 */
export class WriteGuard {
  readonly #before = new Map<string, Snapshot>();
  readonly #clean = new Map<string, boolean>();

  constructor(
    private readonly members: readonly string[],
    /** The only folder the agent may write to, e.g. `<root>/openspec`. */
    private readonly allowed: string,
  ) {}

  begin(): void {
    for (const member of this.members) {
      const snap: Snapshot = new Map();
      scan(member, this.allowed, snap);
      this.#before.set(member, snap);
      this.#clean.set(member, isCleanRepo(member));
    }
  }

  finish(): WriteViolation[] {
    const violations: WriteViolation[] = [];
    for (const member of this.members) {
      const before = this.#before.get(member) ?? new Map();
      const after: Snapshot = new Map();
      scan(member, this.allowed, after);
      const found: Omit<WriteViolation, "reverted">[] = [];
      for (const [path, sig] of after) {
        if (!before.has(path)) found.push({ path, change: "criado" });
        else if (before.get(path) !== sig) found.push({ path, change: "modificado" });
      }
      for (const path of before.keys()) if (!after.has(path)) found.push({ path, change: "removido" });
      if (found.length === 0) continue;

      const reverted = this.#clean.get(member) === true && this.#revert(member, found);
      violations.push(...found.map((v) => ({ ...v, reverted })));
    }
    return violations.sort((a, b) => a.path.localeCompare(b.path));
  }

  #revert(member: string, found: Omit<WriteViolation, "reverted">[]): boolean {
    const tracked = found.filter((v) => v.change !== "criado").map((v) => relative(member, v.path));
    const created = found.filter((v) => v.change === "criado").map((v) => v.path);
    if (tracked.length > 0 && !git(member, ["checkout", "--", ...tracked]).ok) return false;
    for (const path of created) rmSync(path, { force: true });
    return git(member, ["status", "--porcelain"]).out.trim() === "";
  }
}

/**
 * The folder OpenCode treats as the project's worktree: the top of the Git work tree that
 * holds `dir`, or `/` outside Git. OpenCode matches `edit` rules against paths relative to it.
 */
export function engineWorktree(dir: string): string {
  try {
    const top = git(dir, ["rev-parse", "--show-toplevel"]);
    return top.ok && top.out.trim() ? top.out.trim() : "/";
  } catch {
    return "/"; // the folder does not exist (yet)
  }
}

/**
 * Session permissions: read anywhere in the workspace, write only under the OpenSpec
 * root (plus `writable`, e.g. the app's discovery folder), no shell, nothing else outside
 * the workspace (design D8). `edit` rules come in two forms because OpenCode matches them
 * against the worktree-relative path; WriteGuard is the engine-independent backstop.
 */
export function sessionPermissions(
  root: string,
  members: readonly string[],
  writable: readonly string[] = [],
  worktree = engineWorktree(root),
  /** False for a session that only reads the workspace, such as the verification's (add-change-verification D2). */
  openspecWritable = true,
) {
  const openspec = join(root, "openspec");
  const readable = [root, ...members.filter((m) => !isWithin(root, m))];
  const editPatterns = (dir: string) => {
    const rel = relative(worktree, dir);
    return rel ? [`${dir}/**`, `${rel}/**`] : [`${dir}/**`];
  };
  return [
    { permission: "external_directory", pattern: "*", action: "deny" as const },
    { permission: "edit", pattern: "*", action: "deny" as const },
    ...[...(openspecWritable ? [openspec] : []), ...writable].flatMap((dir) =>
      editPatterns(dir).map((pattern) => ({ permission: "edit", pattern, action: "allow" as const })),
    ),
    ...writable.map((dir) => ({ permission: "external_directory", pattern: `${dir}/**`, action: "allow" as const })),
    { permission: "bash", pattern: "*", action: "deny" as const },
    ...readable.flatMap((dir) => [
      { permission: "read", pattern: `${dir}/**`, action: "allow" as const },
      { permission: "external_directory", pattern: `${dir}/**`, action: "allow" as const },
    ]),
  ];
}

/**
 * Apply session permissions (add-visual-apply D2): write in every member and under the
 * root's `openspec/` except the change's `tasks.md`, which only the user's acceptance marks;
 * run the workspace's allowed commands; ask the user for any other command. OpenCode checks
 * each part of a compound command on its own, but a redirection is not a part, so `*>*`
 * asks again after the allowed commands (spike Apply 1.1).
 */
export function applyPermissions(opts: {
  root: string;
  members: readonly string[];
  tasksFile: string;
  commands: readonly string[];
  worktree?: string;
}) {
  const { root, members, tasksFile, commands } = opts;
  const worktree = opts.worktree ?? engineWorktree(root);
  const both = (path: string, suffix: string) => {
    const rel = relative(worktree, path);
    return rel ? [`${path}${suffix}`, `${rel}${suffix}`] : [`${path}${suffix}`];
  };
  const outside = members.filter((m) => !isWithin(root, m));
  const writable = [join(root, "openspec"), ...members.filter((m) => !isWithin(join(root, "openspec"), m))];
  const command = (cmd: string) => [cmd, `${cmd} *`].map((pattern) => ({ permission: "bash", pattern, action: "allow" as const }));
  return [
    { permission: "external_directory", pattern: "*", action: "deny" as const },
    { permission: "edit", pattern: "*", action: "deny" as const },
    { permission: "bash", pattern: "*", action: "ask" as const },
    ...writable.flatMap((dir) => both(dir, "/**").map((pattern) => ({ permission: "edit", pattern, action: "allow" as const }))),
    // A member that is the worktree itself (a mono-repo in Git): its files have plain
    // relative paths, and anything outside it starts with `../`.
    ...(writable.some((dir) => relative(worktree, dir) === "")
      ? [
          { permission: "edit", pattern: "*", action: "allow" as const },
          { permission: "edit", pattern: "../*", action: "deny" as const },
        ]
      : []),
    ...both(tasksFile, "").map((pattern) => ({ permission: "edit", pattern, action: "deny" as const })),
    ...[root, ...outside].flatMap((dir) => [
      { permission: "read", pattern: `${dir}/**`, action: "allow" as const },
      { permission: "external_directory", pattern: dir, action: "allow" as const },
      { permission: "external_directory", pattern: `${dir}/**`, action: "allow" as const },
    ]),
    ...commands.filter((c) => !c.includes(">")).flatMap(command),
    { permission: "bash", pattern: "*>*", action: "ask" as const },
    // A redirection the user allowed on purpose ("Sempre neste workspace") stays allowed.
    ...commands.filter((c) => c.includes(">")).flatMap(command),
  ];
}
