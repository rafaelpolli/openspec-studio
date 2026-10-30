import type { GitFailureKind } from "@studio/shared";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { processRunner, type CommandRunner } from "../apply/environments.ts";

/** A Git action failed and left the repository as it was (HTTP 422, design D5). */
export class GitActionError extends Error {
  override readonly name = "GitActionError";
  constructor(
    message: string,
    readonly kind: GitFailureKind,
    readonly output: string,
  ) {
    super(message);
  }
}

/** The request does not fit the folder's Git state, such as an init inside a repo (HTTP 409). */
export class GitStateError extends Error {
  override readonly name = "GitStateError";
}

/** The path is not a member or the root of the workspace (HTTP 404). */
export class GitAreaNotFoundError extends Error {
  override readonly name = "GitAreaNotFoundError";
}

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  timedOut: boolean;
}

/** Commits wait for hooks and signing; anything longer is a prompt nobody will answer (D4). */
export const COMMIT_TIMEOUT_MS = 60_000;

/**
 * Runs the machine's `git` for the app, never asking on a terminal. `env` is added to the
 * backend's own environment; tests use it for an isolated HOME.
 */
export class GitClient {
  constructor(
    private readonly opts: { env?: Record<string, string>; runner?: CommandRunner; commitTimeoutMs?: number } = {},
  ) {}

  get commitTimeoutMs(): number {
    return this.opts.commitTimeoutMs ?? COMMIT_TIMEOUT_MS;
  }

  async run(cwd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitResult> {
    const res = await (this.opts.runner ?? processRunner).run(["git", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...this.opts.env, ...opts.env },
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    return { ok: res.exitCode === 0 && !res.timedOut, out: res.stdout, err: res.stderr, timedOut: res.timedOut ?? false };
  }

  /** Like `run`, but a failure is an error with Git's output. */
  async must(cwd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
    const res = await this.run(cwd, args, opts);
    if (!res.ok) throw new GitActionError(`git ${args[0]} falhou: ${(res.err || res.out).trim()}`, "outro", res.err + res.out);
    return res.out;
  }

  /**
   * `git commit` with the given extra arguments and environment, turned into a GitActionError
   * whose kind tells the UI what to offer (D5).
   */
  async commit(cwd: string, args: string[], env: Record<string, string> = {}): Promise<void> {
    const res = await this.run(cwd, ["commit", "-q", ...args], { env, timeoutMs: this.commitTimeoutMs });
    if (res.ok) return;
    const output = (res.err + res.out).trim();
    const kind = await this.#classify(cwd, output, res.timedOut, args.includes("--no-verify"));
    throw new GitActionError(FAILURE_TEXT[kind], kind, output);
  }

  async #classify(cwd: string, output: string, timedOut: boolean, noVerify: boolean): Promise<GitFailureKind> {
    if (/please tell me who you are|empty ident|unable to auto-detect email/i.test(output)) return "identidade";
    const signs = (await this.run(cwd, ["config", "--bool", "--get", "commit.gpgsign"])).out.trim() === "true";
    if (/gpg failed|failed to sign|error: gpg|signing failed|ssh-keygen/i.test(output) || (timedOut && signs)) return "assinatura";
    if (!noVerify && (await this.#hasHooks(cwd))) return "hook";
    return "outro";
  }

  async #hasHooks(cwd: string): Promise<boolean> {
    if ((await this.run(cwd, ["config", "--get", "core.hooksPath"])).ok) return true;
    for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg"]) {
      const path = (await this.run(cwd, ["rev-parse", "--git-path", `hooks/${hook}`])).out.trim();
      if (path && existsSync(isAbsolute(path) ? path : join(cwd, path))) return true;
    }
    return false;
  }
}

const FAILURE_TEXT: Record<GitFailureKind, string> = {
  identidade: "o Git não sabe quem é o autor: defina o nome e o e-mail deste repo",
  assinatura: "o commit precisa ser assinado e o assinador falhou ou ficou esperando uma senha: faça este commit pelo terminal",
  hook: "um hook do repo recusou o commit",
  outro: "o Git não conseguiu fazer o commit",
};
