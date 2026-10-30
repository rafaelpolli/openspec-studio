import type { ArtifactStatus, Assumption, ProposalArtifact, ProposalState, ValidationIssue } from "@studio/shared";

export interface Approval {
  contentHash: string;
  /** Hash of each dependency when this artifact was approved. */
  deps: Record<string, string>;
}

export interface StateInput {
  artifacts: readonly ArtifactStatus[];
  /** Current content hash of each artifact that has files. */
  hashes: Readonly<Record<string, string>>;
  approvals: Readonly<Record<string, Approval>>;
  generating: string | null;
  issues: Readonly<Record<string, ValidationIssue[]>>;
  /** The decisions checkpoint is not answered nor skipped: the first artifact waits for it (add-proposal-decisions D4). */
  decisionsPending?: boolean;
  /** Hash of the checkpoint's current answers. */
  answersHash?: string;
  /** Each artifact's last generation: its assumptions and the answers hash it was written with. */
  generations?: Readonly<Record<string, { assumptions: Assumption[]; decisionsHash: string }>>;
}

/** Shown in `waitingOn` while the first artifact waits for the decisions checkpoint. */
export const DECISIONS_DEP = "decisões";

/**
 * Derives each artifact's state in the guided flow from the CLI status, the stored
 * approvals and the current content hashes (design D6). Content changes after approval
 * invalidate it; a dependency that changed after approval makes it "a revisar".
 */
export function proposalStates(input: StateInput): ProposalArtifact[] {
  const approved = (id: string) => stateOf(id) === "aprovado";
  // A generation written with other answers than the current ones (add-proposal-decisions D4).
  const stale = (id: string) => {
    const g = input.generations?.[id];
    return !!g && input.hashes[id] !== undefined && g.decisionsHash !== (input.answersHash ?? "");
  };
  const cache = new Map<string, ProposalState>();
  const byId = new Map(input.artifacts.map((a) => [a.id, a]));

  function stateOf(id: string): ProposalState {
    const known = cache.get(id);
    if (known) return known;
    const a = byId.get(id);
    let s: ProposalState;
    if (!a) s = "bloqueado";
    else if (a.status === "skipped") s = "ignorado";
    else if (input.generating === id) s = "gerando";
    else if (input.hashes[id] !== undefined) {
      const approval = input.approvals[id];
      if (stale(id)) s = "a_revisar";
      else if (!approval || approval.contentHash !== input.hashes[id]) s = "aguardando_aprovacao";
      else if (a.requires.some((d) => approval.deps[d] !== input.hashes[d])) s = "a_revisar";
      else s = "aprovado";
    } else {
      const unmet = a.requires.filter((d) => {
        const dep = stateOf(d);
        return dep !== "aprovado" && dep !== "ignorado";
      });
      s = unmet.length === 0 && !(input.decisionsPending && a.requires.length === 0) ? "pronto" : "bloqueado";
    }
    cache.set(id, s);
    return s;
  }

  return input.artifacts.map((a) => {
    const written = input.hashes[a.id] !== undefined;
    const gen = input.generations?.[a.id];
    const waitingOn = a.requires.filter((d) => !approved(d) && stateOf(d) !== "ignorado");
    if (input.decisionsPending && a.requires.length === 0 && !written) waitingOn.push(DECISIONS_DEP);
    return {
      id: a.id,
      requires: a.requires,
      state: stateOf(a.id),
      waitingOn,
      issues: written ? (input.issues[a.id] ?? []) : [],
      ...(written && gen ? { assumptions: gen.assumptions } : {}),
      ...(stale(a.id) ? { staleDecisions: true } : {}),
    };
  });
}

/** Artifacts whose files live under `specs/` are the ones `openspec validate` checks. */
export function isDeltaSpecArtifact(outputPath: string): boolean {
  return outputPath.startsWith("specs/");
}

/**
 * Splits a validation report among artifacts: delta-spec issues (paths relative to
 * `specs/`, or the change-level "no deltas" error) go to the spec artifact.
 */
export function issuesByArtifact(
  artifacts: readonly ArtifactStatus[],
  issues: readonly ValidationIssue[],
): Record<string, ValidationIssue[]> {
  const spec = artifacts.find((a) => isDeltaSpecArtifact(a.outputPath));
  if (!spec) return {};
  const relevant = issues.filter((i) => i.level === "ERROR" || i.level === "WARNING");
  return { [spec.id]: relevant };
}
