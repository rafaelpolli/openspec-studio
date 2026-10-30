import { describe, expect, test } from "bun:test";
import type { VerificationItem } from "@studio/shared";
import { openDatabase } from "../db.ts";
import { VerificationRepo } from "./repo.ts";

function setup() {
  const db = openDatabase(":memory:");
  db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
  return new VerificationRepo(db);
}

const item = (id: string, result: VerificationItem["result"]): VerificationItem => ({ id, kind: "cenario", result });

describe("4.1 repositório de verificações", () => {
  test("the latest finished report and the running attempt; the verdict comes from the items", () => {
    const repo = setup();
    const first = repo.create("w", "c", { a: "1" });
    repo.save({ ...first, status: "concluida", finishedAt: "t1", items: [item("x", "coberto"), item("y", "sem-teste")] });
    const second = repo.create("w", "c", { a: "2" });
    expect(repo.running("w", "c")?.id).toBe(second.id);
    expect(repo.hasRunning("w")).toBe(true);
    expect(repo.latest("w", "c")).toMatchObject({ id: first.id, verdict: "CONCERNS", finishedAt: "t1", fingerprint: { a: "1" } });
    repo.save({ ...second, status: "concluida", items: [item("x", "falhou")] });
    expect(repo.latest("w", "c")).toMatchObject({ id: second.id, verdict: "FAIL" });
    expect(repo.running("w", "c")).toBeUndefined();
    expect(repo.hasRunning("w")).toBe(false);
  });

  test("prune keeps the last finished report and the latest attempt; an interrupted attempt keeps the old report", () => {
    const repo = setup();
    const ids = [1, 2, 3].map(() => {
      const v = repo.create("w", "c", {});
      repo.save({ ...v, status: "concluida" });
      return v.id;
    });
    const failed = repo.create("w", "c", {});
    repo.save({ ...failed, status: "falhou", error: "o agente falhou" });
    repo.create("w", "outra", {});
    repo.prune("w", "c");
    expect(repo.get(ids[0]!)).toBeUndefined();
    expect(repo.get(ids[1]!)).toBeUndefined();
    expect(repo.latest("w", "c")?.id).toBe(ids[2]!);
    expect(repo.lastAttempt("w", "c")).toMatchObject({ id: failed.id, error: "o agente falhou" });
    expect(repo.running("w", "outra")).toBeDefined();
  });

  test("after a restart a running verification is interrupted; removeChange forgets the change", () => {
    const repo = setup();
    const v = repo.create("w", "c", {});
    repo.interruptRunning();
    expect(repo.get(v.id)).toMatchObject({ status: "interrompida", error: "A aplicação foi reiniciada durante a verificação" });
    repo.removeChange("w", "c");
    expect(repo.lastAttempt("w", "c")).toBeUndefined();
  });
});
