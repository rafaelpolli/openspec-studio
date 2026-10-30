import type { CapabilityDraft, Estimate, WorkspaceMember } from "@studio/shared";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveInside } from "../workspaces/paths.ts";

const SKIP = new Set([".git", "node_modules"]);
/** Tokens per byte of source, and the fixed cost of one baseline session (prompt + output). */
const TOKENS_PER_BYTE = 0.25;
const SESSION_TOKENS = { min: 4_000, max: 12_000 };

function walk(path: string, seen: Map<string, number>): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    seen.set(path, st.size);
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(path)) if (!SKIP.has(name)) walk(join(path, name), seen);
}

/**
 * How much code the batch will read: files and bytes under each capability's locations,
 * counted once per capability because each runs in its own session (design D9, "Estimativa").
 */
export function estimate(
  caps: readonly CapabilityDraft[],
  members: readonly WorkspaceMember[],
  concurrency: number,
): Estimate {
  const byName = new Map(members.map((m) => [m.name, m.path]));
  let files = 0;
  let bytes = 0;
  for (const cap of caps) {
    const seen = new Map<string, number>();
    for (const loc of cap.locations) {
      const base = byName.get(loc.member);
      if (!base) continue;
      try {
        walk(resolveInside([base], join(base, loc.path)), seen);
      } catch {
        // A location outside its member is ignored, never read.
      }
    }
    files += seen.size;
    for (const size of seen.values()) bytes += size;
  }
  const read = bytes * TOKENS_PER_BYTE;
  return {
    capabilities: caps.length,
    files,
    bytes,
    tokens: {
      min: Math.round(read + caps.length * SESSION_TOKENS.min),
      max: Math.round(read * 2 + caps.length * SESSION_TOKENS.max),
    },
    concurrency,
  };
}
