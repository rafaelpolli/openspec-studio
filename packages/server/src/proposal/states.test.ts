import { describe, expect, test } from "bun:test";
import type { ArtifactStatus } from "@studio/shared";
import { issuesByArtifact, proposalStates, type StateInput } from "./states.ts";

const ARTIFACTS: ArtifactStatus[] = [
  { id: "proposal", outputPath: "proposal.md", status: "done", requires: [] },
  { id: "specs", outputPath: "specs/**/*.md", status: "ready", requires: ["proposal"] },
  { id: "design", outputPath: "design.md", status: "ready", requires: ["proposal"] },
  { id: "tasks", outputPath: "tasks.md", status: "blocked", requires: ["specs", "design"] },
];

const states = (input: Partial<StateInput>) =>
  Object.fromEntries(
    proposalStates({ artifacts: ARTIFACTS, hashes: {}, approvals: {}, generating: null, issues: {}, ...input }).map((a) => [
      a.id,
      a.state,
    ]),
  );

describe("proposal states (7.4)", () => {
  test("a written but unapproved proposal blocks its dependents (Sem aprovação)", () => {
    expect(states({ hashes: { proposal: "h1" } })).toEqual({
      proposal: "aguardando_aprovacao",
      specs: "bloqueado",
      design: "bloqueado",
      tasks: "bloqueado",
    });
  });

  test("Aprovação libera o próximo: approving the proposal makes specs and design ready", () => {
    expect(states({ hashes: { proposal: "h1" }, approvals: { proposal: { contentHash: "h1", deps: {} } } })).toEqual({
      proposal: "aprovado",
      specs: "pronto",
      design: "pronto",
      tasks: "bloqueado",
    });
  });

  test("an edit after approval (also an external one) sends it back to awaiting approval", () => {
    expect(
      states({ hashes: { proposal: "h2" }, approvals: { proposal: { contentHash: "h1", deps: {} } } }).proposal,
    ).toBe("aguardando_aprovacao");
  });

  test("Proposal alterada depois: an approved design whose proposal changed is a revisar", () => {
    const s = states({
      hashes: { proposal: "h2", design: "d1" },
      approvals: {
        proposal: { contentHash: "h2", deps: {} },
        design: { contentHash: "d1", deps: { proposal: "h1" } },
      },
    });
    expect(s.design).toBe("a_revisar");
    expect(s.proposal).toBe("aprovado");
  });

  test("tasks becomes ready only when specs and design are both approved; generating is shown", () => {
    const approvals = {
      proposal: { contentHash: "p", deps: {} },
      specs: { contentHash: "s", deps: { proposal: "p" } },
      design: { contentHash: "d", deps: { proposal: "p" } },
    };
    expect(states({ hashes: { proposal: "p", specs: "s" }, approvals }).tasks).toBe("bloqueado");
    expect(states({ hashes: { proposal: "p", specs: "s", design: "d" }, approvals }).tasks).toBe("pronto");
    expect(states({ hashes: { proposal: "p", specs: "s", design: "d" }, approvals, generating: "tasks" }).tasks).toBe(
      "gerando",
    );
  });

  test("waitingOn names the dependencies that block an artifact", () => {
    const view = proposalStates({ artifacts: ARTIFACTS, hashes: { proposal: "p" }, approvals: {}, generating: null, issues: {} });
    expect(view.find((a) => a.id === "tasks")?.waitingOn).toEqual(["specs", "design"]);
  });

  test("skipped artifacts do not block dependents", () => {
    const skipped = ARTIFACTS.map((a) => (a.id === "specs" ? { ...a, status: "skipped" as const } : a));
    const view = proposalStates({
      artifacts: skipped,
      hashes: { proposal: "p", design: "d" },
      approvals: { proposal: { contentHash: "p", deps: {} }, design: { contentHash: "d", deps: { proposal: "p" } } },
      generating: null,
      issues: {},
    });
    expect(Object.fromEntries(view.map((a) => [a.id, a.state]))).toMatchObject({ specs: "ignorado", tasks: "pronto" });
  });

  test("validation issues are attributed to the delta-spec artifact", () => {
    const issues = [{ level: "ERROR", path: "export/spec.md", message: "must include at least one scenario" }];
    expect(issuesByArtifact(ARTIFACTS, issues)).toEqual({ specs: issues });
  });
});

describe("3.3 decisões nos estados (add-proposal-decisions D4)", () => {
  const full = (input: Partial<StateInput>) =>
    proposalStates({ artifacts: ARTIFACTS, hashes: {}, approvals: {}, generating: null, issues: {}, ...input });

  test("a pending checkpoint blocks only the unwritten first artifact, waiting on the decisions", () => {
    const pending = full({ decisionsPending: true });
    expect(pending.find((a) => a.id === "proposal")).toMatchObject({ state: "bloqueado", waitingOn: ["decisões"] });
    // Written before the checkpoint existed (or by the agent meanwhile): its normal state.
    expect(full({ decisionsPending: true, hashes: { proposal: "h1" } }).find((a) => a.id === "proposal")!.state).toBe("aguardando_aprovacao");
  });

  test("Resposta alterada depois: generated artifacts with other answers are a revisar, approved or not", () => {
    const approvals = { proposal: { contentHash: "h1", deps: {} }, design: { contentHash: "h3", deps: { proposal: "h1" } } };
    const generations = {
      proposal: { assumptions: [{ text: "s" }], decisionsHash: "a1" },
      design: { assumptions: [], decisionsHash: "a1" },
      specs: { assumptions: [], decisionsHash: "a1" },
    };
    const hashes = { proposal: "h1", specs: "h2", design: "h3" };
    const same = full({ hashes, approvals, generations, answersHash: "a1" });
    expect(Object.fromEntries(same.map((a) => [a.id, a.state]))).toEqual({ proposal: "aprovado", specs: "aguardando_aprovacao", design: "aprovado", tasks: "bloqueado" });
    expect(same.find((a) => a.id === "proposal")!.assumptions).toEqual([{ text: "s" }]);
    const changed = full({ hashes, approvals, generations, answersHash: "a2" });
    expect(Object.fromEntries(changed.map((a) => [a.id, a.state]))).toEqual({ proposal: "a_revisar", specs: "a_revisar", design: "a_revisar", tasks: "bloqueado" });
    expect(changed.filter((a) => a.staleDecisions).map((a) => a.id)).toEqual(["proposal", "specs", "design"]);
    // An artifact generated before this change has no generation: never stale by decisions.
    expect(full({ hashes, approvals, answersHash: "a2" }).some((a) => a.staleDecisions)).toBe(false);
  });
});
