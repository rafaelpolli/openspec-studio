import type { ProjectType } from "@studio/shared";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORED = /^(readme|license|licence|copying)(\..*)?$/i;

/** True when `dir` holds any source file, ignoring dotfiles, docs boilerplate and `openspec/`. */
export function hasCode(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "openspec" || IGNORED.test(entry.name)) continue;
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasCode(join(dir, entry.name))) return true;
  }
  return false;
}

/** True when `rootPath` has an initialized OpenSpec root (`openspec/config.yaml`). */
export function hasOpenSpecRoot(rootPath: string): boolean {
  const dir = join(rootPath, "openspec");
  return existsSync(join(dir, "config.yaml")) || existsSync(join(dir, "config.yml"));
}

/**
 * Whether the init wizard applies (spec: project-onboarding, "Inicializar greenfield").
 * A mono-repo needs it until it has `openspec/`. A store gets `openspec/` from
 * `store setup`, so it needs init until the OpenCode commands are installed.
 */
export function needsInit(kind: "mono" | "multi", rootPath: string): boolean {
  if (kind === "multi") return !existsSync(join(rootPath, ".opencode", "commands"));
  return !existsSync(join(rootPath, "openspec"));
}

/** True when the OpenSpec root already carries specs or changes (active or archived). */
function hasOpenSpecContent(openspecDir: string): boolean {
  const nonEmpty = (path: string) => {
    try {
      return readdirSync(path).some((name) => !name.startsWith(".") && name !== "archive");
    } catch {
      return false;
    }
  };
  return (
    nonEmpty(join(openspecDir, "specs")) ||
    nonEmpty(join(openspecDir, "changes")) ||
    nonEmpty(join(openspecDir, "changes", "archive"))
  );
}

/**
 * Classifies a workspace:
 * - `inicializado`: the root has OpenSpec with specs or changes, or has OpenSpec and
 *   there is no code to baseline (a greenfield project right after init);
 * - `brownfield`: members have code and the root has no specs or changes yet;
 * - `greenfield`: no OpenSpec and no code.
 */
export function detectProjectType(rootPath: string, memberPaths: readonly string[]): ProjectType {
  const openspecDir = join(rootPath, "openspec");
  const initialized = hasOpenSpecRoot(rootPath);
  if (initialized && hasOpenSpecContent(openspecDir)) return "inicializado";
  const code = memberPaths.some(hasCode);
  if (code) return "brownfield";
  return initialized ? "inicializado" : "greenfield";
}
