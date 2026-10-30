import { homedir } from "node:os";
import { join } from "node:path";

/** Directory holding all app state (database, embedded engine data). */
export function dataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.STUDIO_DATA_DIR) return env.STUDIO_DATA_DIR;
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "openspec-studio");
}

export function dbPath(env: Record<string, string | undefined> = process.env): string {
  return join(dataDir(env), "studio.db");
}

export const HOSTNAME = "127.0.0.1";
