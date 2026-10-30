import type { Database } from "bun:sqlite";
import type { Workspace } from "@studio/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Scripts the initial list allows (spec: change-apply, "Comandos permitidos"). */
const SCRIPTS = ["test", "lint", "typecheck", "build"];

/** The command that runs a package.json script, by the lockfile the member has. */
function runner(dir: string): (script: string) => string {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return (s) => `bun run ${s}`;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return (s) => `pnpm run ${s}`;
  if (existsSync(join(dir, "yarn.lock"))) return (s) => `yarn run ${s}`;
  return (s) => `npm run ${s}`;
}

/** The test, lint, typecheck and build scripts found in the members' package.json files. */
export function detectCommands(dirs: readonly string[]): string[] {
  const found = new Set<string>();
  for (const dir of dirs) {
    let pkg: { scripts?: Record<string, unknown> };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const run = runner(dir);
    for (const script of SCRIPTS) if (typeof pkg.scripts?.[script] === "string") found.add(run(script));
  }
  return [...found];
}

const settingKey = (workspaceId: string) => `apply-commands:${workspaceId}`;

/** Normalizes a command for the list: trimmed, inner whitespace collapsed. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * The commands the agent may run without asking during a workspace's apply (add-visual-apply
 * D8). Seeded from the members' package.json on first read; changes apply to the next apply
 * session, since a session's rules are fixed when it is created.
 */
export class CommandList {
  constructor(private readonly db: Database) {}

  get(ws: Workspace): string[] {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(settingKey(ws.id));
    if (row) return JSON.parse(row.value) as string[];
    const seeded = detectCommands([ws.rootPath, ...ws.members.map((m) => m.path)]);
    this.set(ws.id, seeded);
    return seeded;
  }

  set(workspaceId: string, commands: readonly string[]): string[] {
    const list = [...new Set(commands.map(normalizeCommand).filter(Boolean))];
    this.db
      .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(settingKey(workspaceId), JSON.stringify(list));
    return list;
  }

  add(ws: Workspace, command: string): string[] {
    return this.set(ws.id, [...this.get(ws), command]);
  }
}
