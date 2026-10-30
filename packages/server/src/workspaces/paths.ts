import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export class AccessDeniedError extends Error {
  override readonly name = "AccessDeniedError";
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolves symlinks for the deepest existing ancestor, so not-yet-created files are checked too. */
function realpathLenient(path: string): string {
  let current = path;
  const tail: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Restricts file access to the given base directories (a workspace's root and members).
 * `path` may be absolute or relative to the first base. Symlinks are resolved before
 * the check, so a link pointing outside the workspace is rejected.
 */
export function resolveInside(bases: readonly string[], path: string): string {
  const [first] = bases;
  if (!first) throw new AccessDeniedError("workspace has no accessible directories");
  const target = realpathLenient(resolve(first, path));
  if (bases.some((base) => isWithin(realpathLenient(resolve(base)), target))) return target;
  throw new AccessDeniedError(`access outside the workspace is not allowed: ${path}`);
}
