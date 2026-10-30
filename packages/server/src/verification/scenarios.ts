import type { SpecScenario } from "@studio/shared";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Delta sections whose scenarios describe behavior the change must have (D1). */
const VERIFIED = /^##\s+(ADDED|MODIFIED)\s+Requirements\s*$/i;

/**
 * The scenarios of one delta spec's ADDED and MODIFIED requirements. REMOVED and RENAMED
 * sections are skipped; headings inside code fences are not headings.
 */
export function parseScenarios(capability: string, spec: string): SpecScenario[] {
  const out: SpecScenario[] = [];
  let inVerified = false;
  let requirement: string | undefined;
  let current: { name: string; lines: string[] } | undefined;
  let fence = false;
  const flush = () => {
    if (current && requirement) {
      out.push({
        id: `${capability}/${requirement}/${current.name}`,
        capability,
        requirement,
        name: current.name,
        text: current.lines.join("\n").trim(),
      });
    }
    current = undefined;
  };
  for (const line of spec.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      if (/^##\s/.test(line)) {
        flush();
        inVerified = VERIFIED.test(line.trim());
        requirement = undefined;
        continue;
      }
      const req = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
      if (req) {
        flush();
        requirement = inVerified ? req[1]! : undefined;
        continue;
      }
      const sc = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line);
      if (sc) {
        flush();
        if (requirement) current = { name: sc[1]!, lines: [] };
        continue;
      }
      if (/^#{1,4}\s/.test(line)) {
        flush();
        continue;
      }
    }
    current?.lines.push(line);
  }
  flush();
  return out;
}

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...specFiles(path));
    else if (name === "spec.md") out.push(path);
  }
  return out;
}

/** Every verified scenario of the change at `changeDir`, by capability path. */
export function changeScenarios(changeDir: string): SpecScenario[] {
  const specs = join(changeDir, "specs");
  if (!existsSync(specs)) return [];
  return specFiles(specs).flatMap((file) => {
    const capability = relative(specs, join(file, "..")).split(sep).join("/");
    return parseScenarios(capability, readFileSync(file, "utf8"));
  });
}
