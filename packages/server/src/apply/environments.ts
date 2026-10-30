import type { EnvironmentState, EnvironmentStatus, Workspace } from "@studio/shared";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventBus } from "../events.ts";
import { STOCK_IMAGES, type EnvironmentStore } from "./environment.ts";

/** Runs a command to completion, streaming its output lines. A fake replaces it in tests. */
export interface CommandRunner {
  run(
    cmd: string[],
    opts?: { onLine?: (line: string) => void; timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
}

export const processRunner: CommandRunner = {
  async run(cmd, opts = {}) {
    let proc;
    try {
      proc = Bun.spawn(cmd, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch (err) {
      return { exitCode: 127, stdout: "", stderr: (err as Error).message };
    }
    let timedOut = false;
    const readers: { cancel(): Promise<void> }[] = [];
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
          // A grandchild (gpg's pinentry, say) may keep the pipes open after the kill.
          for (const r of readers) void r.cancel().catch(() => {});
        }, opts.timeoutMs)
      : undefined;
    const read = async (stream: ReadableStream<Uint8Array>) => {
      let all = "";
      let pending = "";
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      readers.push(reader);
      while (true) {
        const { value: chunk, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
        if (done) break;
        const text = decoder.decode(chunk, { stream: true });
        all += text;
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) opts.onLine?.(line);
      }
      if (pending) opts.onLine?.(pending);
      return all;
    };
    const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { exitCode, stdout, stderr, ...(timedOut ? { timedOut } : {}) };
  },
};

/** The environment cannot be prepared; the task does not start (D6). */
export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
}

/** A container ready to host the workspace's apply engine. */
export interface ReadyEnvironment {
  containerId: string;
  remoteUser: string;
  /** Folder (mounted at the same path) that holds the engine's data for this workspace. */
  engineDir: string;
}

/** What a command the app ran in the apply environment returned. */
export interface ExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

const joinOutput = (stdout: string, stderr: string) => [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");

/** Folders of the image a member path must not fall into, since members keep their path (D2). */
const SYSTEM_DIRS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/proc", "/root", "/sbin", "/sys", "/usr", "/var"];
const MAX_OUTPUT = 200;
const LABEL = "studio.workspace";

interface Entry {
  state: EnvironmentState;
  output: string[];
  error?: string;
  containerId?: string;
  remoteUser?: string;
  hash?: string;
  uidMismatch?: boolean;
  lastUsed: number;
  preparing?: Promise<ReadyEnvironment>;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The apply containers, one per workspace (add-apply-devcontainer D3, D5, D6): prepared with
 * the devcontainer CLI on the machine's Node, reused across tasks and changes, stopped when
 * idle, found again by label after a restart.
 */
export class EnvironmentManager {
  readonly #entries = new Map<string, Entry>();
  readonly #stopped = new Set<(workspaceId: string) => Promise<void> | void>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: EnvironmentStore,
    private readonly events: EventBus,
    private readonly opts: {
      /** Where generated configs and the engines' data live. */
      dataDir: string;
      /** The devcontainer CLI entry point, run with `node`. */
      cliPath: string;
      runner?: CommandRunner;
      now?: () => number;
    },
  ) {}

  get #runner(): CommandRunner {
    return this.opts.runner ?? processRunner;
  }

  #now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Checks idle containers every minute. */
  start(): void {
    this.#timer = setInterval(() => void this.sweepIdle(), 60_000);
    this.#timer.unref?.();
  }

  close(): void {
    clearInterval(this.#timer);
  }

  /**
   * Called before a workspace's container is stopped, so its engine stops first; otherwise the
   * engine would see its process end and restart it, bringing the container back up.
   */
  onStopped(listener: (workspaceId: string) => Promise<void> | void): void {
    this.#stopped.add(listener);
  }

  engineDir(workspaceId: string): string {
    return join(this.opts.dataDir, workspaceId, "engine");
  }

  status(ws: Workspace): EnvironmentStatus {
    const mode = this.store.get(ws.id).mode;
    const e = this.#entries.get(ws.id);
    if (!e) return { mode, state: "ausente", output: [] };
    const current = mode === "local" ? undefined : this.#configHash(ws);
    return {
      mode,
      state: e.state,
      output: e.output,
      ...(e.error ? { error: e.error } : {}),
      ...(e.hash && current && current !== e.hash && e.state !== "preparando" ? { needsRebuild: true } : {}),
      ...(e.uidMismatch ? { uidMismatch: true } : {}),
    };
  }

  /** Marks the environment as used now, which postpones the idle stop. */
  touch(workspaceId: string): void {
    const e = this.#entries.get(workspaceId);
    if (e) e.lastUsed = this.#now();
  }

  /** The running container, preparing (or starting) it when needed. */
  async ensure(ws: Workspace, opts: { rebuild?: boolean } = {}): Promise<ReadyEnvironment> {
    const e = this.#entries.get(ws.id);
    if (e?.preparing) return e.preparing;
    if (!opts.rebuild && e?.state === "pronto" && e.containerId && e.remoteUser) {
      e.lastUsed = this.#now();
      return { containerId: e.containerId, remoteUser: e.remoteUser, engineDir: this.engineDir(ws.id) };
    }
    const entry: Entry = { state: "preparando", output: [], lastUsed: this.#now() };
    if (e?.containerId) entry.containerId = e.containerId;
    this.#entries.set(ws.id, entry);
    entry.preparing = this.#prepare(ws, entry, opts.rebuild ?? false).finally(() => delete entry.preparing);
    this.#changed(ws.id);
    return entry.preparing;
  }

  /**
   * Runs a command for the app (not the agent) where the workspace's apply runs: in its
   * container, or on the machine in local mode (add-change-verification D5). In the container
   * the time limit is also applied inside it, since killing `docker exec` leaves the process
   * running there. The output keeps the last lines of stdout and stderr together.
   */
  async exec(ws: Workspace, argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<ExecResult> {
    const tail = (text: string) => text.split("\n").slice(-MAX_OUTPUT).join("\n");
    if (this.store.get(ws.id).mode === "local") {
      const res = await this.#runner.run(argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
      return { exitCode: res.exitCode, output: tail(joinOutput(res.stdout, res.stderr)), timedOut: !!res.timedOut };
    }
    const env = await this.ensure(ws);
    this.touch(ws.id);
    const seconds = String(Math.max(1, Math.ceil(opts.timeoutMs / 1000)));
    const cmd = ["docker", "exec", "-u", env.remoteUser, "-w", opts.cwd, env.containerId, "timeout", "-s", "KILL", seconds, ...argv];
    const res = await this.#runner.run(cmd, { timeoutMs: opts.timeoutMs + 15_000 });
    this.touch(ws.id);
    // `timeout -s KILL` exits with 137 when it had to kill the command.
    const timedOut = !!res.timedOut || res.exitCode === 137;
    return { exitCode: res.exitCode, output: tail(joinOutput(res.stdout, res.stderr)), timedOut };
  }

  async rebuild(ws: Workspace): Promise<ReadyEnvironment> {
    return this.ensure(ws, { rebuild: true });
  }

  async stop(ws: Workspace): Promise<EnvironmentStatus> {
    const e = this.#entries.get(ws.id);
    if (e?.containerId && e.state === "pronto") await this.#stopContainer(ws.id, e);
    return this.status(ws);
  }

  /** Stops every ready container idle for longer than its workspace allows (D5). */
  async sweepIdle(): Promise<void> {
    for (const [id, e] of this.#entries) {
      if (e.state !== "pronto" || !e.containerId) continue;
      if (this.#now() - e.lastUsed < this.store.get(id).idleMinutes * 60_000) continue;
      await this.#stopContainer(id, e);
    }
  }

  /** After a restart, finds each workspace's container by its label; it counts as stopped (D5). */
  async recover(workspaces: readonly Workspace[]): Promise<void> {
    for (const ws of workspaces) {
      if (this.store.get(ws.id).mode === "local") continue;
      const res = await this.#runner.run(
        ["docker", "ps", "-a", "--filter", `label=${LABEL}=${ws.id}`, "--format", "{{.ID}}"],
        { timeoutMs: 30_000 },
      );
      const id = res.stdout.trim().split("\n")[0];
      if (res.exitCode === 0 && id) {
        this.#entries.set(ws.id, { state: "parado", output: [], containerId: id, lastUsed: this.#now() });
      }
    }
  }

  // --- internals -----------------------------------------------------------

  async #stopContainer(workspaceId: string, e: Entry): Promise<void> {
    for (const l of this.#stopped) await Promise.resolve(l(workspaceId)).catch(() => {});
    await this.#runner.run(["docker", "stop", e.containerId!], { timeoutMs: 60_000 });
    e.state = "parado";
    this.#changed(workspaceId);
  }

  async #prepare(ws: Workspace, entry: Entry, rebuild: boolean): Promise<ReadyEnvironment> {
    try {
      const mode = this.store.get(ws.id).mode;
      if (mode === "local") throw new EnvironmentError("este workspace roda o apply sem container");
      await this.#preflight(ws);
      const { folder, config } = this.#config(ws);
      const engineDir = this.engineDir(ws.id);
      mkdirSync(engineDir, { recursive: true });
      const mounts = [...new Set([ws.rootPath, ...ws.members.map((m) => m.path), engineDir])];
      const cmd = [
        "node",
        this.opts.cliPath,
        "up",
        "--workspace-folder",
        folder,
        "--config",
        config,
        "--id-label",
        `${LABEL}=${ws.id}`,
        ...mounts.flatMap((p) => ["--mount", `type=bind,source=${p},target=${p}`]),
        ...(rebuild ? ["--remove-existing-container"] : []),
      ];
      const res = await this.#runner.run(cmd, { onLine: (line) => this.#output(ws.id, entry, line), timeoutMs: 30 * 60_000 });
      const result = lastJson(res.stdout);
      if (res.exitCode !== 0 || result?.outcome !== "success" || !result.containerId) {
        throw new EnvironmentError(
          `o preparo do container falhou: ${result?.message ?? (res.stderr.trim().split("\n").at(-1) || `código ${res.exitCode}`)}`,
        );
      }
      const remoteUser = result.remoteUser ?? "root";
      const uid = await this.#runner.run(["docker", "exec", "-u", remoteUser, result.containerId, "id", "-u"], { timeoutMs: 30_000 });
      entry.containerId = result.containerId;
      entry.remoteUser = remoteUser;
      const hash = this.#configHash(ws);
      if (hash) entry.hash = hash;
      entry.uidMismatch = uid.stdout.trim() !== String(process.getuid?.() ?? "");
      entry.state = "pronto";
      entry.lastUsed = this.#now();
      delete entry.error;
      this.#changed(ws.id);
      return { containerId: result.containerId, remoteUser, engineDir };
    } catch (err) {
      entry.state = "falhou";
      entry.error = (err as Error).message;
      this.#changed(ws.id);
      throw err instanceof EnvironmentError ? err : new EnvironmentError(entry.error);
    }
  }

  async #preflight(ws: Workspace): Promise<void> {
    const docker = await this.#runner.run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000 });
    if (docker.exitCode !== 0) {
      const reason = docker.stderr.trim().split("\n")[0] || "o comando docker não respondeu";
      throw new EnvironmentError(`o Docker não está acessível nesta máquina (${reason})`);
    }
    const node = await this.#runner.run(["node", "--version"], { timeoutMs: 30_000 });
    const major = Number(/^v(\d+)/.exec(node.stdout.trim())?.[1] ?? 0);
    if (node.exitCode !== 0 || major < 18) {
      throw new EnvironmentError("o modo container precisa do Node 18 ou mais novo instalado nesta máquina");
    }
    for (const path of [ws.rootPath, ...ws.members.map((m) => m.path)]) {
      const clash = SYSTEM_DIRS.find((d) => path === d || path.startsWith(`${d}/`));
      if (clash) {
        throw new EnvironmentError(`${path} cai em ${clash}, uma pasta do sistema da imagem; não dá para montá-lo no mesmo caminho`);
      }
    }
  }

  /** The workspace folder and config file the CLI gets; stock images get a config the app writes. */
  #config(ws: Workspace): { folder: string; config: string } {
    const mode = this.store.get(ws.id).mode;
    if (mode.startsWith("devcontainer:")) {
      const config = mode.slice("devcontainer:".length);
      if (!existsSync(config)) throw new EnvironmentError(`o arquivo ${config} não existe mais`);
      return { folder: dirname(dirname(config)), config };
    }
    const image = STOCK_IMAGES.find((i) => `imagem:${i.id}` === mode);
    if (!image) throw new EnvironmentError(`imagem padrão desconhecida: ${mode}`);
    const config = join(this.opts.dataDir, ws.id, "devcontainer.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(
      config,
      JSON.stringify(
        {
          name: `openspec-studio ${ws.name}`,
          image: image.image,
          // The root and members come in through --mount at their own paths (D2); a
          // workspaceMount at the same path would be a duplicate mount point.
          updateRemoteUserUID: true,
        },
        null,
        2,
      ),
    );
    return { folder: ws.rootPath, config };
  }

  #configHash(ws: Workspace): string | undefined {
    const mode = this.store.get(ws.id).mode;
    if (mode.startsWith("devcontainer:")) {
      const path = mode.slice("devcontainer:".length);
      return existsSync(path) ? sha(readFileSync(path, "utf8")) : undefined;
    }
    return mode === "local" ? undefined : sha(mode);
  }

  #output(workspaceId: string, entry: Entry, line: string): void {
    entry.output.push(line);
    if (entry.output.length > MAX_OUTPUT) entry.output.splice(0, entry.output.length - MAX_OUTPUT);
    this.#changed(workspaceId);
  }

  #changed(workspaceId: string): void {
    this.events.publish({ type: "environment-changed", workspaceId });
  }
}

/** The CLI ends with one JSON line, e.g. `{"outcome":"success","containerId":"…","remoteUser":"vscode"}`. */
function lastJson(stdout: string): { outcome?: string; containerId?: string; remoteUser?: string; message?: string } | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // not the result line
    }
  }
  return undefined;
}
