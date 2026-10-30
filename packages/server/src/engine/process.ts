import type { Subprocess } from "bun";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Variables copied from the backend environment into the engine; everything else is dropped. */
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR"] as const;

export interface EngineBinary {
  path: string;
  version: string;
}

/** Locates the OpenCode binary bundled as the `opencode-ai` dependency (never from PATH). */
export function bundledBinary(): EngineBinary {
  const pkgFile = Bun.resolveSync("opencode-ai/package.json", import.meta.dir);
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { version: string; bin: { opencode: string } };
  return { path: join(dirname(pkgFile), pkg.bin.opencode), version: pkg.version };
}

/**
 * Builds the engine environment from an allowlist (design D4): provider keys exported
 * in the shell never reach the engine, and all OpenCode state lives under `dataDir`.
 */
export function engineEnv(opts: {
  dataDir: string;
  password: string;
  config: unknown;
  source?: Record<string, string | undefined>;
}): Record<string, string> {
  const source = opts.source ?? process.env;
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  const xdg = (name: string) => {
    const dir = join(opts.dataDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    ...env,
    XDG_CONFIG_HOME: xdg("config"),
    XDG_DATA_HOME: xdg("data"),
    XDG_STATE_HOME: xdg("state"),
    XDG_CACHE_HOME: xdg("cache"),
    OPENCODE_SERVER_PASSWORD: opts.password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opts.config),
  };
}

export function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export interface RunningServer {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  url: string;
}

/** Spawns `opencode serve` and resolves once it reports its listening URL. */
export async function spawnServer(opts: {
  binary: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
  /** Runs this instead of the binary (e.g. `docker exec` into a container); it must print the listening URL. */
  command?: string[];
  /** Rewrites the printed URL into one the backend can reach. */
  rewriteUrl?: (url: string) => string;
}): Promise<RunningServer> {
  const port = freePort();
  const proc = Bun.spawn(opts.command ?? [opts.binary, "serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`engine did not start within ${opts.timeoutMs ?? 20_000}ms`)), opts.timeoutMs ?? 20_000);
  });
  const ready = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        await proc.exited;
        throw new Error(`engine exited with code ${proc.exitCode}: ${(output + (await stderr)).trim()}`);
      }
      output += decoder.decode(value, { stream: true });
      const match = /opencode server listening on (http:\/\/\S+)/.exec(output);
      if (match) return opts.rewriteUrl ? opts.rewriteUrl(match[1]!) : match[1]!;
    }
  })();
  try {
    const url = await Promise.race([ready, timeout]);
    // Keep draining stdout so the child never blocks on a full pipe.
    void (async () => {
      while (!(await reader.read()).done) {
        /* discard */
      }
    })().catch(() => {});
    return { proc, url };
  } catch (err) {
    proc.kill("SIGKILL");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Terminates the engine, escalating to SIGKILL if it does not exit promptly. */
export async function stopServer(proc: Subprocess, graceMs = 3_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  if (!exited) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}
