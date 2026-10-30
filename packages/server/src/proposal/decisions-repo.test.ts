import { describe, expect, test } from "bun:test";
import type { DecisionCheckpoint } from "@studio/shared";
import { openDatabase } from "../db.ts";
import { answersHash, DecisionsRepo } from "./decisions-repo.ts";

function setup() {
  const db = openDatabase(":memory:");
  db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
  return new DecisionsRepo(db);
}

const checkpoint: DecisionCheckpoint = {
  status: "aguardando",
  decisions: [{ id: "campos", question: "Quais campos?", options: [{ label: "Todos" }, { label: "Só nome" }], recommended: 1 }],
  answers: [],
  resumeAuto: false,
};

describe("1.2 repositório de decisões", () => {
  test("a change without a checkpoint has none; one saved comes back, updated in place", () => {
    const repo = setup();
    expect(repo.get("w", "c")).toBeNull();
    repo.save("w", "c", checkpoint);
    expect(repo.get("w", "c")).toEqual(checkpoint);
    repo.save("w", "c", { ...checkpoint, status: "respondido", answers: [{ id: "campos", kind: "propria", text: "nome e e-mail" }], resumeAuto: true });
    expect(repo.get("w", "c")).toMatchObject({ status: "respondido", resumeAuto: true, answers: [{ kind: "propria" }] });
  });

  test("generations by artifact, replaced on each generation", () => {
    const repo = setup();
    repo.saveGeneration("w", "c", "proposal", { assumptions: [{ text: "a" }], decisionsHash: "h1" });
    repo.saveGeneration("w", "c", "design", { assumptions: [], decisionsHash: "h1" });
    repo.saveGeneration("w", "c", "proposal", { assumptions: [{ text: "b", question: "q?" }], decisionsHash: "h2" });
    expect(repo.generations("w", "c")).toEqual({
      proposal: { assumptions: [{ text: "b", question: "q?" }], decisionsHash: "h2" },
      design: { assumptions: [], decisionsHash: "h1" },
    });
  });

  test("answersHash: empty unless answered; changes with the answers", () => {
    expect(answersHash(null)).toBe("");
    expect(answersHash({ ...checkpoint, status: "pulado" })).toBe("");
    const a = answersHash({ ...checkpoint, status: "respondido", answers: [{ id: "campos", kind: "recomendada" }] });
    const b = answersHash({ ...checkpoint, status: "respondido", answers: [{ id: "campos", kind: "opcao", option: 0 }] });
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });

  test("after a restart a checkpoint being raised has failed", () => {
    const repo = setup();
    repo.save("w", "c", { ...checkpoint, status: "levantando" });
    repo.interruptRunning();
    expect(repo.get("w", "c")).toMatchObject({ status: "falhou", error: "A aplicação foi reiniciada enquanto as decisões eram levantadas" });
  });
});
