import type { ItemProof, ProofResult, Workspace } from "@studio/shared";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import type { TaskEntry } from "../apply/repo.ts";
import { diffSnapshots, repoTop, snapshot } from "../apply/snapshot.ts";
import type { TestEnvironment } from "./service.ts";

/** Dependency folders linked into both copies, so the tests can run there (D6). */
const DEPENDENCIES = ["node_modules", ".venv", "venv"];
const TEST_DIRS = new Set(["test", "tests", "__tests__", "testing"]);

/** Whether a member-relative path is a test file, kept as it is now in the copy from before. */
export function isTestFile(path: string): boolean {
  const name = basename(path);
  if (/\.(test|spec)\.[^.]+$/.test(name) || /^test_.*\.py$/.test(name) || /_test\.py$/.test(name) || name === "conftest.py") return true;
  return path.split("/").slice(0, -1).some((segment) => TEST_DIRS.has(segment));
}

function git(cwd: string, args: string[], env?: Record<string, string>) {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  if (res.exitCode !== 0) throw new Error(`git ${args[0]} falhou: ${res.stderr.toString().trim()}`);
  return res.stdout.toString();
}

/** The member's tree from before the change: the `before` of the change's first task that ran in it. */
export function beforeTree(entries: readonly TaskEntry[], member: string): string | undefined {
  return [...entries].sort((a, b) => a.position - b.position).find((e) => e.before[member])?.before[member];
}

/**
 * The tree "code from before the change, tests from now" (D6): `now` with every file the
 * change touched put back as it was in `before`, except the test files.
 */
export function previousTree(member: string, before: string, now: string): string {
  const top = repoTop(member);
  const revert = diffSnapshots(member, before, now).filter((f) => !isTestFile(f.path));
  const dir = mkdtempSync(join(tmpdir(), "studio-proof-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    git(top, ["read-tree", now], env);
    for (const f of revert) {
      const path = relative(top, join(member, f.path));
      const entry = git(top, ["ls-tree", before, "--", path]).trim();
      if (entry) {
        const [meta] = entry.split("\t");
        const [mode, , blob] = meta!.split(" ");
        git(top, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], env);
      } else {
        git(top, ["update-index", "--force-remove", "--", path], env);
      }
    }
    return git(top, ["write-tree"], env).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes the member's part of `tree` into `dir`, without touching the member's repository. */
async function extract(member: string, tree: string, dir: string): Promise<void> {
  const top = repoTop(member);
  const prefix = relative(top, member);
  mkdirSync(dir, { recursive: true });
  const archive = Bun.spawn(["git", "archive", "--format=tar", prefix ? `${tree}:${prefix}` : tree], { cwd: top, stdout: "pipe", stderr: "pipe" });
  const tar = Bun.spawn(["tar", "-x", "-C", dir], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  const [a, t] = await Promise.all([archive.exited, tar.exited]);
  if (a !== 0 || t !== 0) throw new Error(`não foi possível montar a cópia: ${await new Response(tar.stderr).text()}`);
}

/** The dependency folders of the member, linked (not copied) into a copy. */
function linkDependencies(member: string, dir: string): void {
  for (const name of DEPENDENCIES) {
    if (existsSync(join(member, name)) && !existsSync(join(dir, name))) symlinkSync(join(member, name), join(dir, name));
  }
}

export function classify(control: boolean, previous: boolean): ProofResult {
  if (!control) return "inconclusiva";
  return previous ? "fraca" : "forte";
}

/**
 * Red → green proof of one test (D6): runs `argv` on a copy of the member as it is now
 * (control) and on a copy with the code from before the change. Both copies go under
 * `workDir`, which is removed at the end; the member itself is never touched.
 */
export async function prove(input: {
  ws: Workspace;
  member: string;
  before: string;
  argv: string[];
  workDir: string;
  environment: TestEnvironment;
  timeoutMs: number;
}): Promise<ItemProof> {
  const { ws, member, argv, workDir, environment, timeoutMs } = input;
  try {
    const now = snapshot(member);
    const previous = previousTree(member, input.before, now);
    const control = join(workDir, "controle");
    const old = join(workDir, "anterior");
    await extract(member, now, control);
    await extract(member, previous, old);
    // Files Git does not track (ignored config such as .env) are not copied; dependencies are linked.
    for (const dir of [control, old]) linkDependencies(member, dir);
    const c = await environment.exec(ws, argv, { cwd: control, timeoutMs });
    const p = await environment.exec(ws, argv, { cwd: old, timeoutMs });
    const ok = (r: typeof c) => r.exitCode === 0 && !r.timedOut;
    return { status: "concluida", result: classify(ok(c), ok(p)), control: c.output, before: p.output };
  } catch (err) {
    return { status: "falhou", error: (err as Error).message };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
