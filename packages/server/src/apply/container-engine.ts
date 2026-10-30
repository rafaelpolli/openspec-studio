import type { Workspace } from "@studio/shared";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EngineLauncher } from "../engine/opencode.ts";
import type { CommandRunner, EnvironmentManager } from "./environments.ts";
import { EnvironmentError, processRunner } from "./environments.ts";

/** Where the engine binary goes inside the container: a root-owned folder (D4). */
export const CONTAINER_BINARY = "/opt/studio/opencode";
const PORT = 4096;

export type BinaryVariant = `opencode-linux-${"x64" | "arm64"}${"" | "-musl"}`;

/** Downloads in progress, so two workspaces preparing at once fetch a variant only once. */
const downloads = new Map<string, Promise<string>>();

/**
 * Finds (or downloads) the OpenCode binary of `variant` at the embedded `version`. Bun installs
 * only the machine's own variant, as an optional dependency of `opencode-ai`; the others come
 * from the npm registry once and are kept in the app's data (spike Devcontainer 1.1).
 */
export async function binaryFor(variant: BinaryVariant, version: string, cacheDir: string, runner: CommandRunner = processRunner): Promise<string> {
  try {
    const engine = dirname(Bun.resolveSync("opencode-ai/package.json", import.meta.dir));
    const pkg = Bun.resolveSync(`${variant}/package.json`, engine);
    const local = join(dirname(pkg), "bin", "opencode");
    const installed = JSON.parse(readFileSync(pkg, "utf8")) as { version: string };
    if (installed.version === version && existsSync(local)) return local;
  } catch {
    // not installed: download it
  }
  const key = `${variant}-${version}`;
  const bin = join(cacheDir, key, "package", "bin", "opencode");
  if (existsSync(bin)) return bin;
  let pending = downloads.get(key);
  if (!pending) {
    pending = download(variant, version, join(cacheDir, key), runner).finally(() => downloads.delete(key));
    downloads.set(key, pending);
  }
  return pending;
}

async function download(variant: BinaryVariant, version: string, dir: string, runner: CommandRunner): Promise<string> {
  // Unpacked in a temporary folder and moved in place, so a half-written binary is never used.
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const url = `https://registry.npmjs.org/${variant}/-/${variant}-${version}.tgz`;
    const res = await fetch(url);
    if (!res.ok) throw new EnvironmentError(`não foi possível baixar ${variant}@${version} (${res.status})`);
    const tgz = join(tmp, "package.tgz");
    writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()));
    const untar = await runner.run(["tar", "xzf", tgz, "-C", tmp], { timeoutMs: 120_000 });
    rmSync(tgz, { force: true });
    if (untar.exitCode !== 0 || !existsSync(join(tmp, "package", "bin", "opencode"))) {
      throw new EnvironmentError(`o pacote ${variant}@${version} não tem o binário esperado`);
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return join(dir, "package", "bin", "opencode");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Runs a workspace's apply engine inside its container (add-apply-devcontainer D4): the
 * container is prepared first, the right binary is copied in and made root-owned, the
 * provider credentials are copied into the workspace's engine data, and the engine runs as
 * the machine's user, reached at the container's IP with no published port.
 */
export class ContainerLauncher implements EngineLauncher {
  #containerId: string | undefined;

  constructor(
    private readonly ws: () => Workspace,
    private readonly manager: EnvironmentManager,
    private readonly opts: {
      /** The local engine's auth.json, copied before each start. */
      authFile: string;
      version: string;
      /** Where downloaded binaries are kept. */
      cacheDir: string;
      runner?: CommandRunner;
      binaryFor?: (variant: BinaryVariant) => Promise<string>;
    },
  ) {}

  get #runner(): CommandRunner {
    return this.opts.runner ?? processRunner;
  }

  async prepare(env: Record<string, string>) {
    const ws = this.ws();
    const ready = await this.manager.ensure(ws);
    const id = ready.containerId;
    this.#containerId = id;
    const docker = async (args: string[], what: string) => {
      const res = await this.#runner.run(["docker", ...args], { timeoutMs: 120_000 });
      if (res.exitCode !== 0) throw new EnvironmentError(`${what} falhou: ${res.stderr.trim() || res.stdout.trim()}`);
      return res.stdout.trim();
    };

    const probe = await docker(["exec", id, "sh", "-c", "uname -m; ls /lib/ld-musl-* >/dev/null 2>&1 && echo musl || echo glibc"], "detectar a plataforma do container");
    const [machine, libc] = probe.split("\n");
    const arch = machine === "aarch64" || machine === "arm64" ? "arm64" : machine === "x86_64" ? "x64" : undefined;
    if (!arch) throw new EnvironmentError(`a arquitetura ${machine} do container não tem binário do OpenCode`);
    const variant = `opencode-linux-${arch}${libc === "musl" ? "-musl" : ""}` as BinaryVariant;
    const binary = await (this.opts.binaryFor ?? ((v) => binaryFor(v, this.opts.version, this.opts.cacheDir, this.#runner)))(variant);

    // docker cp keeps the source's owner: without the chown the container's user could replace the engine.
    await docker(["exec", "-u", "0", id, "mkdir", "-p", dirname(CONTAINER_BINARY)], "criar a pasta do motor");
    await docker(["cp", binary, `${id}:${CONTAINER_BINARY}`], "copiar o motor para o container");
    await docker(["exec", "-u", "0", id, "sh", "-c", `chown root:root ${CONTAINER_BINARY} && chmod 755 ${CONTAINER_BINARY}`], "proteger o binário do motor");

    // Credentials: a fresh copy of the app's auth.json in this workspace's engine data.
    const auth = join(env.XDG_DATA_HOME!, "opencode", "auth.json");
    mkdirSync(dirname(auth), { recursive: true });
    if (existsSync(this.opts.authFile)) {
      copyFileSync(this.opts.authFile, auth);
      chmodSync(auth, 0o600);
    } else rmSync(auth, { force: true });

    const ip = await docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", id], "achar o IP do container");
    if (!ip) throw new EnvironmentError("o container não tem IP na rede do Docker");

    // The environment goes in a file outside the mounted folders, so the password is not on a command line.
    const envFile = join(dirname(ready.engineDir), "engine.env");
    const vars: Record<string, string> = { ...env, HOME: join(ready.engineDir, "home") };
    delete vars.PATH; // the image's PATH
    writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v.replace(/\n/g, " ")}`).join("\n") + "\n", { mode: 0o600 });
    chmodSync(envFile, 0o600);
    mkdirSync(join(ready.engineDir, "home"), { recursive: true });

    const pidFile = join(ready.engineDir, "engine.pid");
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    return {
      command: [
        "docker",
        "exec",
        "-i",
        "-u",
        `${uid}:${gid}`,
        "-w",
        ws.rootPath,
        "--env-file",
        envFile,
        id,
        "sh",
        "-c",
        // The engine's stderr goes to a log next to its data, for when it dies inside the container.
        `echo $$ > '${pidFile}'; exec ${CONTAINER_BINARY} serve --hostname 0.0.0.0 --port ${PORT} 2>>'${join(ready.engineDir, "engine.log")}'`,
      ],
      rewriteUrl: (url: string) => url.replace(/\/\/[^/:]+(:\d+)?/, `//${ip}:${PORT}`),
    };
  }

  /** Ending `docker exec` does not end the process inside the container, so it is killed there. */
  async stop(): Promise<void> {
    const id = this.#containerId;
    if (!id) return;
    const pidFile = join(this.manager.engineDir(this.ws().id), "engine.pid");
    await this.#runner.run(["docker", "exec", id, "sh", "-c", `kill $(cat '${pidFile}') 2>/dev/null; rm -f '${pidFile}'`], { timeoutMs: 30_000 });
  }
}
