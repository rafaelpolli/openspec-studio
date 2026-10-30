import type { BaselineRequirement, EvidenceSource } from "@studio/shared";

/** Section the baseline prompt asks for at the end of design.md. */
export const EVIDENCE_HEADING = "## Evidências";

export interface EvidenceRow {
  requirement: string;
  evidence: string[];
  source: EvidenceSource;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Reads the evidence table (requisito → arquivo:linha → testado/inferido) from design.md. */
export function parseEvidenceTable(design: string): EvidenceRow[] {
  const lines = design.split("\n");
  const start = lines.findIndex((l) => /^##\s+(Evidências|Evidencias|Evidence)\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const rows: EvidenceRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (!line.trim().startsWith("|")) continue;
    const [requirement = "", evidence = "", source = ""] = cells(line);
    if (/^-+:?$|^:?-+:?$/.test(requirement) || /^requisito$|^requirement$/i.test(requirement)) continue;
    if (!requirement) continue;
    rows.push({
      requirement,
      evidence: evidence
        .split(/,\s*|<br\s*\/?>/)
        .map((e) => e.replace(/`/g, "").trim())
        .filter(Boolean),
      source: /^test/i.test(source) ? "testado" : "inferido",
    });
  }
  return rows;
}

/** `### Requirement: <name>` blocks of a spec delta, with their text up to the first scenario. */
export function parseRequirements(spec: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  let current: { name: string; lines: string[]; inScenario: boolean } | undefined;
  const flush = () => {
    if (current) out.push({ name: current.name, text: current.lines.join("\n").trim() });
  };
  for (const line of spec.split("\n")) {
    const req = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (req) {
      flush();
      current = { name: req[1]!, lines: [], inScenario: false };
      continue;
    }
    if (!current) continue;
    if (/^##\s/.test(line) || /^###\s/.test(line)) {
      flush();
      current = undefined;
    } else if (/^####\s/.test(line)) current.inScenario = true;
    else if (!current.inScenario) current.lines.push(line);
  }
  flush();
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Joins the spec's requirements with the evidence table. A requirement without a row,
 * or whose row is not `testado`, is inferred (spec: "Requisito sem teste").
 */
export function reviewRequirements(spec: string, design: string): BaselineRequirement[] {
  const rows = new Map(parseEvidenceTable(design).map((r) => [norm(r.requirement), r]));
  return parseRequirements(spec).map((req) => {
    const row = rows.get(norm(req.name));
    return { name: req.name, text: req.text, evidence: row?.evidence ?? [], inferred: row?.source !== "testado" };
  });
}
