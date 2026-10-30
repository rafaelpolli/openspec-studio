import type { ItemResult, ProofResult, SpecScenario, VerificationItem, Workspace } from "@studio/shared";
import { verdictOf } from "@studio/shared";
import type { VerificationRecord } from "./repo.ts";

const RESULT: Record<ItemResult, string> = {
  aguardando: "aguardando",
  rodando: "rodando",
  coberto: "coberto",
  falhou: "falhou",
  "evidencia-invalida": "evidência inválida",
  "nao-executado": "não executado",
  "sem-teste": "sem teste",
  manual: "manual",
};
const PROOF: Record<ProofResult, string> = { forte: "forte", fraca: "fraca", inconclusiva: "inconclusiva" };

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n+/g, " ");

function evidence(item: VerificationItem): string {
  const e = item.evidence;
  if (!e) return item.reason ? cell(item.reason) : "-";
  const where = `\`${e.member}/${e.file}:${e.line}\` "${cell(e.name)}"`;
  return item.reason ? `${where}: ${cell(item.reason)}` : where;
}

function result(item: VerificationItem): string {
  if (item.result === "manual" && item.checked) return "manual (conferido)";
  return RESULT[item.result];
}

function proof(item: VerificationItem): string {
  if (!item.proof) return "-";
  if (item.proof.result) return PROOF[item.proof.result];
  return item.proof.status === "falhou" ? `falhou: ${cell(item.proof.error ?? "")}` : item.proof.status;
}

/** The notes the user left on an item: the check of a manual item and the justification. */
function notes(item: VerificationItem, label: string): string[] {
  const out: string[] = [];
  if (item.checked) out.push(`- **${label}**: conferido${item.checked.note ? ` — ${item.checked.note}` : ""}`);
  if (item.justification) out.push(`- **${label}**: justificativa — ${item.justification}`);
  return out;
}

/**
 * `verification.md` (D7): rewritten from the database after every change, never read back.
 * Scenarios are grouped by capability and requirement, in the order of the delta specs.
 */
export function renderReport(ws: Workspace, v: VerificationRecord): string {
  const lines = [
    `# Verificação: ${v.change}`,
    "",
    `- Veredito: **${verdictOf(v.items)}**`,
    `- Data: ${v.finishedAt ?? v.createdAt}`,
    `- Estado verificado: ${ws.members.map((m) => `${m.name} \`${(v.fingerprint[m.path] ?? "").slice(0, 12)}\``).join(", ")}; artefatos \`${(v.fingerprint["artifacts"] ?? "").slice(0, 12)}\``,
    "",
  ];
  const scenarios = v.items.filter((i): i is VerificationItem & { scenario: SpecScenario } => i.kind === "cenario" && !!i.scenario);
  if (scenarios.length === 0) lines.push("A change não tem cenários a verificar.", "");
  const capabilities = [...new Set(scenarios.map((i) => i.scenario.capability))];
  for (const cap of capabilities) {
    lines.push(`## ${cap}`, "");
    const ofCap = scenarios.filter((i) => i.scenario.capability === cap);
    for (const req of [...new Set(ofCap.map((i) => i.scenario.requirement))]) {
      const ofReq = ofCap.filter((i) => i.scenario.requirement === req);
      lines.push(`### ${req}`, "", "| Cenário | Evidência | Resultado | Prova |", "|---|---|---|---|");
      for (const i of ofReq) lines.push(`| ${cell(i.scenario.name)} | ${evidence(i)} | ${result(i)} | ${proof(i)} |`);
      const extra = ofReq.flatMap((i) => notes(i, i.scenario.name));
      lines.push("", ...(extra.length > 0 ? [...extra, ""] : []));
    }
  }
  const pending = v.items.find((i) => i.kind === "tasks-pendentes");
  if (pending) {
    lines.push("## Tasks pendentes", "", `- ${(pending.pendingTasks ?? []).join(", ")}`, ...notes(pending, "Tasks pendentes"), "");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Adds a pending test task for a scenario to tasks.md (D8): at the end of the "N. Verificação"
 * group, created with the next group number when missing. Returns the new text and task id.
 */
export function addTestTask(markdown: string, scenario: SpecScenario): { markdown: string; id: string } {
  const lines = markdown.replace(/\s+$/, "").split("\n");
  const text = `Teste automatizado para o cenário "${scenario.name}" (${scenario.capability} / ${scenario.requirement})`;
  const headings = lines.map((l, i) => ({ i, m: /^##\s+(\d+)\.\s*(.*?)\s*$/.exec(l) })).filter((h) => h.m);
  const group = headings.find((h) => /^verifica[çc][ãa]o$/i.test(h.m![2]!));
  if (!group) {
    const n = Math.max(0, ...headings.map((h) => Number(h.m![1]))) + 1;
    const id = `${n}.1`;
    return { markdown: [...lines, "", `## ${n}. Verificação`, "", `- [ ] ${id} ${text}`, ""].join("\n"), id };
  }
  const n = group.m![1]!;
  const next = headings.find((h) => h.i > group.i)?.i ?? lines.length;
  let end = next;
  while (end > group.i + 1 && lines[end - 1]!.trim() === "") end--;
  const taken = lines
    .slice(group.i + 1, end)
    .map((l) => new RegExp(`^\\s*[-*]\\s+\\[[^\\]]*\\]\\s+${n.replace(".", "\\.")}\\.(\\d+)\\b`).exec(l)?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
  const id = `${n}.${Math.max(0, ...taken) + 1}`;
  lines.splice(end, 0, `- [ ] ${id} ${text}`);
  return { markdown: `${lines.join("\n")}\n`, id };
}
