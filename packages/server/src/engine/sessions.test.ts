import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.ts";
import { FakeEngine } from "../testing/fake-engine.ts";
import { ChangeSessions } from "./sessions.ts";

const dir = mkdtempSync(join(tmpdir(), "studio-sessions-"));
const dbFile = join(dir, "studio.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seedWorkspace(file: string) {
  const db = openDatabase(file);
  db.run(
    "INSERT OR IGNORE INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/repo', NULL, 'now')",
  );
  return db;
}

describe("ChangeSessions", () => {
  const engine = new FakeEngine();

  test("Ajuste mantém contexto: the same change reuses one session", async () => {
    const sessions = new ChangeSessions(seedWorkspace(dbFile), engine);
    const first = await sessions.forChange("w", "add-export", "/repo");
    expect(first).toMatchObject({ created: true, historyAvailable: true });
    const again = await sessions.forChange("w", "add-export", "/repo");
    expect(again).toEqual({ sessionId: first.sessionId, historyAvailable: true, created: false });
    const other = await sessions.forChange("w", "add-auth", "/repo");
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(sessions.owner(first.sessionId)).toEqual({ workspaceId: "w", change: "add-export", kind: "plan" });
  });

  test("Retomar após reinício: the stored session is reused when the engine still has it", async () => {
    const before = new ChangeSessions(seedWorkspace(dbFile), engine).stored("w", "add-export");
    // A new backend over the same database file.
    const restarted = new ChangeSessions(seedWorkspace(dbFile), engine);
    expect(await restarted.forChange("w", "add-export", "/repo")).toEqual({
      sessionId: before!,
      historyAvailable: true,
      created: false,
    });
  });

  test("Retomar após reinício: a session the engine lost is replaced and flagged", async () => {
    const lost = new FakeEngine(); // fresh engine: knows no previous sessions
    const restarted = new ChangeSessions(seedWorkspace(dbFile), lost);
    const previous = restarted.stored("w", "add-export");
    const session = await restarted.forChange("w", "add-export", "/repo");
    expect(session.created).toBe(true);
    expect(session.historyAvailable).toBe(false);
    expect(session.sessionId).not.toBe(previous);
    expect(restarted.stored("w", "add-export")).toBe(session.sessionId);
  });

  test("Apply em sessão própria: the apply session is separate and reused for the next task", async () => {
    const sessions = new ChangeSessions(seedWorkspace(dbFile), engine);
    const plan = await sessions.forChange("w", "add-export", "/repo");
    const rules = [{ permission: "bash", pattern: "*", action: "ask" as const }];
    const apply = await sessions.forChange("w", "add-export", "/repo", rules, "apply");
    expect(apply.created).toBe(true);
    expect(apply.sessionId).not.toBe(plan.sessionId);
    expect(engine.permissions.get(apply.sessionId)).toEqual(rules);
    const next = await sessions.forChange("w", "add-export", "/repo", rules, "apply");
    expect(next).toEqual({ sessionId: apply.sessionId, historyAvailable: true, created: false });
    expect(sessions.isApply(apply.sessionId)).toBe(true);
    expect(sessions.isApply(plan.sessionId)).toBe(false);
    expect(sessions.stored("w", "add-export")).toBe(plan.sessionId);
  });

  test("forget drops the mapping", async () => {
    const sessions = new ChangeSessions(seedWorkspace(dbFile), engine);
    sessions.forget("w", "add-auth");
    expect(sessions.stored("w", "add-auth")).toBeUndefined();
  });
});
