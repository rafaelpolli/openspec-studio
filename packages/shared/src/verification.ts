// Verification of an implemented change, and its archive (add-change-verification).

/** A `#### Scenario:` of an ADDED or MODIFIED requirement in one of the change's delta specs. */
export interface SpecScenario {
  /** `<capability>/<requirement>/<scenario>`. */
  id: string;
  /** Spec path under `specs/`, such as `git-repositories` or `identity/user-auth`. */
  capability: string;
  requirement: string;
  name: string;
  /** The scenario's WHEN/THEN lines. */
  text: string;
}

/** How the agent classified a scenario. */
export type TraceKind = "teste" | "manual" | "sem-teste";

/** The test the agent pointed to for a scenario. */
export interface TestEvidence {
  member: string;
  /** Path relative to the member. */
  file: string;
  line: number;
  name: string;
}

/**
 * Where an item stands:
 * - `aguardando`/`rodando`: its test has not run yet / is running;
 * - `coberto`: the test passed; `falhou`: it failed;
 * - `evidencia-invalida`: the evidence did not check out, so nothing ran;
 * - `nao-executado`: the member's test runner is unknown;
 * - `sem-teste`, `manual`: as the agent classified it.
 */
export type ItemResult =
  | "aguardando"
  | "rodando"
  | "coberto"
  | "falhou"
  | "evidencia-invalida"
  | "nao-executado"
  | "sem-teste"
  | "manual";

/** Red → green proof (D6): "forte" fails before the change and passes now. */
export type ProofResult = "forte" | "fraca" | "inconclusiva";

export interface ItemProof {
  status: "rodando" | "concluida" | "falhou";
  result?: ProofResult;
  /** Output of the test on the current state (the control copy). */
  control?: string;
  /** Output of the test on the code from before the change. */
  before?: string;
  error?: string;
}

export interface VerificationItem {
  /** The scenario id, or `tasks-pendentes`. */
  id: string;
  kind: "cenario" | "tasks-pendentes";
  scenario?: SpecScenario;
  /** Ids of the tasks still unchecked in tasks.md, for the `tasks-pendentes` item. */
  pendingTasks?: string[];
  trace?: TraceKind;
  evidence?: TestEvidence;
  /** The agent's note on the item. */
  note?: string;
  result: ItemResult;
  /** Why the evidence is invalid or the test did not run. */
  reason?: string;
  /** The argv run (or that would be run) for the test. */
  command?: string[];
  output?: string;
  proof?: ItemProof;
  /** Set when the user marked a manual item as checked. */
  checked?: { note?: string };
  justification?: string;
}

export type Verdict = "PASS" | "CONCERNS" | "FAIL";

export type VerificationStatus = "rodando" | "concluida" | "falhou" | "interrompida";

export interface VerificationReport {
  id: string;
  change: string;
  status: VerificationStatus;
  createdAt: string;
  finishedAt?: string;
  items: VerificationItem[];
  verdict?: Verdict;
  error?: string;
}

/** Why archive is (or is not) allowed, as the gate computes it. */
export interface ArchiveGate {
  allowed: boolean;
  reason?: string;
  /** Items that cause CONCERNS and still need a justification. */
  missing: string[];
  /** The OpenSpec root is in a Git repository: "Arquivar e commitar" is offered. */
  git: boolean;
}

export interface VerificationState {
  change: string;
  /** The verification running now, if any. */
  running?: VerificationReport;
  /** The last finished verification. */
  report?: VerificationReport;
  /** Why the latest attempt ended without a report (failed or interrupted), when it is newer than `report`. */
  lastError?: string;
  /** The code or the change's artifacts changed since `report` (D7). */
  stale: boolean;
  canStart: boolean;
  startReason?: string;
  /** Why the red → green proof is not offered for this change, when it is not. */
  proofUnavailable?: string;
  archive: ArchiveGate;
}

/** Whether an item keeps the verdict from PASS, before any justification. */
export function isConcern(item: VerificationItem): boolean {
  if (item.kind === "tasks-pendentes") return true;
  if (item.result === "manual") return !item.checked;
  if (item.result === "coberto") return item.proof?.result === "fraca";
  return item.result !== "falhou";
}

/** The verdict of a set of items (spec: "Veredito da verificação"). */
export function verdictOf(items: readonly VerificationItem[]): Verdict {
  if (items.some((i) => i.result === "falhou")) return "FAIL";
  return items.some(isConcern) ? "CONCERNS" : "PASS";
}
