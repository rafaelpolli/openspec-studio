import { CliStatusEntry, VersionReport } from "@studio/shared";
import type { z } from "zod";

export const MIN_OPENSPEC_VERSION = "1.15.0";

/** The `openspec` executable could not be started (missing or not executable). */
export class CliUnavailableError extends Error {
  override readonly name = "CliUnavailableError";
}

/** The CLI ran but reported an error (non-zero exit or an error status entry). */
export class CliError extends Error {
  override readonly name = "CliError";
  constructor(
    message: string,
    readonly code: string,
    readonly fix: string | undefined,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** The CLI output did not match the expected shape. */
export class CliOutputError extends Error {
  override readonly name = "CliOutputError";
}

export class CliTimeoutError extends Error {
  override readonly name = "CliTimeoutError";
}

export class CliVersionError extends Error {
  override readonly name = "CliVersionError";
}

export interface RunOptions {
  /** Working directory; the OpenSpec root resolves from here. */
  cwd: string;
  /** Registered store id; appends `--store <id>` (only for commands that accept it). */
  store?: string | undefined;
  /** Treat a non-zero exit as success when stdout still parses (e.g. failed `validate`). */
  allowNonZero?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface OpenSpecCliOptions {
  bin?: string;
  timeoutMs?: number;
  /** Extra environment for the child (e.g. an isolated XDG_DATA_HOME in tests). */
  env?: Record<string, string>;
}

export class OpenSpecCli {
  readonly bin: string;
  readonly timeoutMs: number;
  readonly env: Record<string, string>;

  constructor(opts: OpenSpecCliOptions = {}) {
    this.bin = opts.bin ?? process.env.STUDIO_OPENSPEC_BIN ?? "openspec";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.env = opts.env ?? {};
  }

  async run(args: readonly string[], opts: RunOptions): Promise<RunResult> {
    const cmd = [this.bin, ...args, ...(opts.store ? ["--store", opts.store] : [])];
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(cmd, {
        cwd: opts.cwd,
        env: { ...process.env, ...this.env, NO_COLOR: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      throw new CliUnavailableError(`could not run '${this.bin}': ${(err as Error).message}`);
    }

    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    let timer: Timer | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
    });
    try {
      // Race on exit rather than on the streams: a grandchild can keep the pipes open.
      const exitCode = await Promise.race([proc.exited, timeout]);
      if (exitCode === "timeout") {
        proc.kill("SIGKILL");
        throw new CliTimeoutError(`'${cmd.join(" ")}' timed out after ${this.timeoutMs}ms`);
      }
      return { stdout: await stdout, stderr: await stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs a `--json` command and validates its output. OpenSpec reports failures as
   * JSON on stdout with a `status` array of error entries, so those are surfaced as
   * CliError even when the exit code alone would be ambiguous.
   */
  async json<S extends z.ZodType>(args: readonly string[], schema: S, opts: RunOptions): Promise<z.infer<S>> {
    const result = await this.run([...args, "--json"], opts);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      if (result.exitCode !== 0) throw this.#failure(result, undefined);
      throw new CliOutputError(`'${args.join(" ")}' did not print JSON`);
    }

    const errorEntry = statusErrors(parsed)[0];
    if (errorEntry) throw this.#failure(result, errorEntry);
    if (result.exitCode !== 0 && !opts.allowNonZero) throw this.#failure(result, undefined);

    const checked = schema.safeParse(parsed);
    if (!checked.success) {
      throw new CliOutputError(`unexpected output from '${args.join(" ")}': ${checked.error.message}`);
    }
    return checked.data;
  }

  async version(): Promise<string> {
    const report = await this.json(["version"], VersionReport, { cwd: process.cwd() });
    return report.version;
  }

  /** Fails with CliVersionError when the installed CLI is older than `min`. */
  async assertVersion(min = MIN_OPENSPEC_VERSION): Promise<string> {
    const version = await this.version();
    if (compareVersions(version, min) < 0) {
      throw new CliVersionError(`OpenSpec ${version} is older than the required ${min}`);
    }
    return version;
  }

  #failure(result: RunResult, entry: CliStatusEntry | undefined): CliError {
    const message = entry?.message ?? (result.stderr.trim() || `exited with code ${result.exitCode}`);
    return new CliError(message, entry?.code ?? "exit_code", entry?.fix, result.stderr);
  }
}

function statusErrors(parsed: unknown): CliStatusEntry[] {
  if (typeof parsed !== "object" || parsed === null || !("status" in parsed)) return [];
  const status = (parsed as { status: unknown }).status;
  if (!Array.isArray(status)) return [];
  return status.flatMap((entry) => {
    const checked = CliStatusEntry.safeParse(entry);
    return checked.success && checked.data.severity === "error" ? [checked.data] : [];
  });
}

/** Compares dotted numeric versions; pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}
