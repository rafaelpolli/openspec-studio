import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Resolves once `pattern` appears on the process output, or rejects on exit/timeout. */
async function waitForOutput(proc: Subprocess<"ignore", "pipe", "pipe">, pattern: RegExp, timeoutMs = 30_000) {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = setTimeout(() => proc.kill(), timeoutMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`process exited before printing ${pattern}:\n${seen}`);
      seen += decoder.decode(value, { stream: true });
      if (pattern.test(seen)) return;
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
}

export interface Stack {
  /** Base URL of the UI (Vite dev server proxying to the backend). */
  url: string;
  /** Scratch folder for test projects; also holds the app data and OpenSpec store registry. */
  dir: string;
  /** Environment that isolates OpenSpec CLI calls made by the test itself. */
  env: Record<string, string>;
  /** The backend's global Git config: an empty file of its own, never the user's ~/.gitconfig. */
  gitConfig: string;
  stop(): Promise<void>;
}

/**
 * Starts the backend and the Vite dev server with app data and the OpenSpec store
 * registry isolated in a temp folder, so the user's real data is never touched.
 */
export async function startStack(
  opts: { scriptedAgent?: boolean; mockLlm?: boolean; entry?: string; gitConfig?: string } = {},
): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "studio-e2e-"));
  const webPort = freePort();
  const gitConfig = join(dir, ".gitconfig");
  writeFileSync(gitConfig, opts.gitConfig ?? "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    STUDIO_DATA_DIR: join(dir, ".studio"),
    XDG_DATA_HOME: join(dir, ".xdg"),
    STUDIO_PORT: "0",
    STUDIO_WEB_PORT: String(webPort),
    STUDIO_DEV_ORIGIN: `http://127.0.0.1:${webPort}`,
    NO_COLOR: "1",
  };

  const entry = opts.entry
    ? opts.entry
    : opts.mockLlm
    ? "src/testing/e2e-apply-server.ts"
    : opts.scriptedAgent
      ? "src/testing/e2e-server.ts"
      : "src/index.ts";
  const backend = Bun.spawn(["bun", entry], {
    cwd: join(REPO, "packages/server"),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForOutput(backend, /listening on/);

  const web = Bun.spawn(["bunx", "--bun", "vite"], {
    cwd: join(REPO, "packages/web"),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForOutput(web, /Local:/);

  return {
    url: `http://127.0.0.1:${webPort}`,
    dir,
    env: { XDG_DATA_HOME: env.XDG_DATA_HOME },
    gitConfig,
    async stop() {
      web.kill();
      backend.kill();
      await Promise.all([web.exited, backend.exited]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
