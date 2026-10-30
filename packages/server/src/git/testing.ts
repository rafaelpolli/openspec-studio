import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitClient } from "./exec.ts";

/**
 * A temp folder with its own HOME, so Git tests read and write a throwaway global config
 * and never the user's `~/.gitconfig`.
 */
export function gitSandbox(prefix = "studio-git-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, ".home");
  mkdirSync(home);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
  const client = new GitClient({ env });
  /** Runs git as the user would, in the same isolated HOME. */
  const sh = (cwd: string, ...args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    return res.stdout.toString();
  };
  const globalIdentity = (name: string, email: string) => {
    sh(dir, "config", "--global", "user.name", name);
    sh(dir, "config", "--global", "user.email", email);
  };
  /** A folder with files; with `commit`, a repo whose first commit has them. */
  const folder = (name: string, files: Record<string, string>, opts: { git?: boolean } = { git: true }) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(path, file, ".."), { recursive: true });
      writeFileSync(join(path, file), content);
    }
    if (opts.git) {
      sh(path, "init", "-q", "-b", "main");
      sh(path, "add", "-A");
      sh(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "inicial");
    }
    return path;
  };
  return { dir, home, env, client, sh, globalIdentity, folder };
}
