import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyRepo } from "./apply/repo.ts";
import { dbPath } from "./config.ts";
import { migrate, openDatabase, SCHEMA_VERSION } from "./db.ts";
import { DecisionsRepo } from "./proposal/decisions-repo.ts";
import { ExplorationRepo } from "./explore/repo.ts";
import { VerificationRepo } from "./verification/repo.ts";

const TABLES = [
  "apply_tasks",
  "artifact_approvals",
  "artifact_generations",
  "change_decisions",
  "change_meta",
  "change_sessions",
  "exploration_messages",
  "explorations",
  "onboarding_capabilities",
  "onboarding_jobs",
  "settings",
  // SQLite's own table, created by the AUTOINCREMENT of exploration_messages.
  "sqlite_sequence",
  "verifications",
  "workspace_members",
  "workspaces",
];

describe("database", () => {
  test("migrations create every table on an empty database", () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-db-"));
    try {
      const db = openDatabase(join(dir, "nested", "studio.db"));
      const names = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => r.name);
      expect(names).toEqual(TABLES);
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(
        SCHEMA_VERSION,
      );
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migrating twice is a no-op", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  test("change sessions from before the apply session become planning sessions (add-visual-apply D1)", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db, 4);
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
    db.run("INSERT INTO change_sessions (workspace_id, change_name, session_id, created_at) VALUES ('w', 'c', 'ses_1', 'now')");
    migrate(db);
    expect(db.query("SELECT change_name, kind, session_id FROM change_sessions").all()).toEqual([
      { change_name: "c", kind: "plan", session_id: "ses_1" },
    ]);
    // The same change can now also hold an apply session.
    db.run("INSERT INTO change_sessions (workspace_id, change_name, kind, session_id, created_at) VALUES ('w', 'c', 'apply', 'ses_2', 'now')");
    expect(db.query("SELECT * FROM change_sessions").all()).toHaveLength(2);
    db.close();
  });

  test("apply tasks from before add-git-commits have no commits, and new ones keep theirs (D2)", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db, 6);
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
    db.run("INSERT INTO apply_tasks (workspace_id, change_name, task_id, position, status, before_json) VALUES ('w', 'c', '1.1', 1, 'aceita', '{}')");
    migrate(db);
    const repo = new ApplyRepo(db);
    expect(repo.list("w", "c")[0]!.commits).toBeUndefined();
    repo.save("w", "c", { taskId: "1.2", position: 2, status: "aguardando-revisao", before: {}, commits: { "/x": "abc" } });
    expect(repo.list("w", "c")[1]!.commits).toEqual({ "/x": "abc" });
    db.close();
  });

  test("v8 adds the verifications table on a database at v7, with the apply history kept (add-change-verification D7)", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db, 7);
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
    db.run("INSERT INTO apply_tasks (workspace_id, change_name, task_id, position, status, before_json) VALUES ('w', 'c', '1.1', 1, 'aceita', '{}')");
    migrate(db);
    expect(new ApplyRepo(db).list("w", "c")).toHaveLength(1);
    const repo = new VerificationRepo(db);
    expect(repo.latest("w", "c")).toBeUndefined();
    const v = repo.create("w", "c", { "/x": "tree" });
    expect(repo.running("w", "c")?.fingerprint).toEqual({ "/x": "tree" });
    db.run("PRAGMA foreign_keys = ON");
    db.run("DELETE FROM workspaces WHERE id = 'w'");
    expect(repo.get(v.id)).toBeUndefined();
    db.close();
  });

  test("v9 adds the decisions tables on a database at v8, with the approvals kept (add-proposal-decisions D3)", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db, 8);
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
    db.run("INSERT INTO artifact_approvals (workspace_id, change_name, artifact_id, content_hash, approved_at) VALUES ('w', 'c', 'proposal', 'h', 'now')");
    migrate(db);
    expect(db.query("SELECT COUNT(*) AS n FROM artifact_approvals").get()).toEqual({ n: 1 });
    const repo = new DecisionsRepo(db);
    expect(repo.get("w", "c")).toBeNull();
    expect(repo.generations("w", "c")).toEqual({});
    db.close();
  });

  test("v10 adds the exploration tables on a database at v9 (add-workspace-explore D2)", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db, 9);
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
    migrate(db);
    const repo = new ExplorationRepo(db);
    const e = repo.create("w");
    repo.addMessage(e.id, "usuario", "oi", "concluida");
    db.run("PRAGMA foreign_keys = ON");
    db.run("DELETE FROM workspaces WHERE id = 'w'");
    expect(db.query("SELECT COUNT(*) AS n FROM exploration_messages").get()).toEqual({ n: 0 });
    db.close();
  });

  test("deleting a workspace cascades to its members", () => {
    const db = openDatabase(":memory:");
    db.run(
      "INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')",
    );
    db.run("INSERT INTO workspace_members (workspace_id, name, path, position) VALUES ('w', 'w', '/x', 0)");
    db.run("DELETE FROM workspaces WHERE id = 'w'");
    expect(db.query("SELECT * FROM workspace_members").all()).toHaveLength(0);
    db.close();
  });

  test("default path lives under the XDG data dir", () => {
    expect(dbPath({ XDG_DATA_HOME: "/data" })).toBe("/data/openspec-studio/studio.db");
    expect(dbPath({ STUDIO_DATA_DIR: "/custom" })).toBe("/custom/studio.db");
  });
});
