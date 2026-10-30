import type { Workspace } from "@studio/shared";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { gitState, snapshot } from "../apply/snapshot.ts";

/** The report file, left out of the fingerprint: writing it must not make the report stale. */
export const REPORT_FILE = "verification.md";
const SKIP = new Set([".git", "node_modules"]);

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function walk(dir: string, base: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name)) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, base, out);
    else out.push(relative(base, path));
  }
}

/** Hash of the files' paths and contents under `dir`, minus the top-level `except` files. */
function contentHash(dir: string, except: readonly string[] = []): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  walk(dir, dir, files);
  for (const file of files) {
    if (except.includes(file)) continue;
    hash.update(file).update("\0").update(readFileSync(join(dir, file))).update("\0");
  }
  return hash.digest("hex");
}

/** Hash of the paths, sizes and times of a folder outside Git. */
function statHash(dir: string, exclude: readonly string[]): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  walk(dir, dir, files);
  for (const file of files) {
    if (exclude.some((e) => isWithin(e, file))) continue;
    const st = statSync(join(dir, file));
    hash.update(`${file}\0${st.size}\0${st.mtimeMs}\0`);
  }
  return hash.digest("hex");
}

/**
 * What a verification checked (D7): each member's files, without the root's `openspec/` when
 * the root is inside the member, plus the change's artifacts without the report.
 */
export function fingerprint(ws: Workspace, changeDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const openspec = join(ws.rootPath, "openspec");
  for (const m of ws.members) {
    const exclude = isWithin(m.path, openspec) ? [relative(m.path, openspec)] : [];
    out[m.path] = gitState(m.path).git ? snapshot(m.path, exclude) : statHash(m.path, exclude);
  }
  out["artifacts"] = contentHash(changeDir, [REPORT_FILE]);
  return out;
}

/** True when two fingerprints differ in any key. */
export function changed(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].some((k) => a[k] !== b[k]);
}
