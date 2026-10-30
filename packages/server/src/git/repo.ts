import type { GitArea, GitConfigScope, GitIdentity, Workspace } from "@studio/shared";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { GitAreaNotFoundError, GitStateError, type GitClient } from "./exec.ts";

/** A folder the app does Git for (D4). */
export interface Area {
  name: string;
  path: string;
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The members, plus the root when it is not inside a member (a multi-repo store). */
export function gitAreas(ws: Workspace): Area[] {
  const areas: Area[] = ws.members.map((m) => ({ name: m.name, path: m.path }));
  if (!areas.some((a) => isWithin(a.path, ws.rootPath))) areas.push({ name: "openspec", path: ws.rootPath });
  return areas;
}

/** The area with this path; any other path is refused (spec workspaces, "Acesso a arquivos somente pelo backend"). */
export function findArea(ws: Workspace, path: string): Area {
  const area = gitAreas(ws).find((a) => resolve(a.path) === resolve(path));
  if (!area) throw new GitAreaNotFoundError(`${path} não é um membro deste workspace`);
  return area;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export interface RepoState {
  git: boolean;
  top?: string;
  branch?: string | null;
  nested?: boolean;
  pending: number;
}

export async function repoState(git: GitClient, path: string): Promise<RepoState> {
  if (!existsSync(path)) return { git: false, pending: 0 };
  const top = await git.run(path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { git: false, pending: 0 };
  const topPath = top.out.trim();
  const branch = await git.run(path, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const status = await git.run(path, ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--", "."]);
  return {
    git: true,
    top: topPath,
    branch: branch.ok ? branch.out.trim() : null,
    nested: real(topPath) !== real(path),
    pending: status.out.split("\0").filter(Boolean).length,
  };
}

/** The effective `user.name` and `user.email` in the folder, and where each comes from. */
export async function identity(git: GitClient, path: string): Promise<GitIdentity> {
  const out: GitIdentity = {};
  for (const key of ["name", "email"] as const) {
    const res = await git.run(existsSync(path) ? path : "/", ["config", "--show-scope", "--get", `user.${key}`]);
    if (!res.ok) continue;
    const [scope, ...value] = res.out.trim().split("\t");
    out[key] = value.join("\t");
    out[`${key}Scope`] = scope as GitConfigScope;
  }
  return out;
}

/** Writes the identity in the repository's own config; the global config is never touched (D4). */
export async function setIdentity(git: GitClient, path: string, name: string, email: string): Promise<void> {
  await requireRepo(git, path);
  await git.must(path, ["config", "--local", "user.name", name]);
  await git.must(path, ["config", "--local", "user.email", email]);
}

export async function clearIdentity(git: GitClient, path: string): Promise<void> {
  await requireRepo(git, path);
  // Exit 5 means the key was not set: nothing to remove.
  for (const key of ["user.name", "user.email"]) await git.run(path, ["config", "--local", "--unset-all", key]);
}

async function requireRepo(git: GitClient, path: string): Promise<void> {
  if (!(await repoState(git, path)).git) throw new GitStateError(`${path} não é um repositório Git`);
}

export async function areaState(git: GitClient, area: Area): Promise<GitArea> {
  const st = await repoState(git, area.path);
  return {
    name: area.name,
    path: area.path,
    git: st.git,
    pending: st.pending,
    ...(st.top ? { top: st.top } : {}),
    ...(st.branch !== undefined ? { branch: st.branch } : {}),
    ...(st.nested ? { nested: true } : {}),
    identity: await identity(git, area.path),
  };
}
