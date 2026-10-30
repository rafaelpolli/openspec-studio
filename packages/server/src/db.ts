import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Ordered schema migrations; the index + 1 is stored in PRAGMA user_version. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('mono', 'multi')),
    root_path   TEXT NOT NULL,
    store_id    TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    path         TEXT NOT NULL,
    position     INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, name)
  );
  CREATE TABLE change_sessions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    change_name  TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (workspace_id, change_name)
  );
  CREATE TABLE artifact_approvals (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    change_name  TEXT NOT NULL,
    artifact_id  TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    approved_at  TEXT NOT NULL,
    PRIMARY KEY (workspace_id, change_name, artifact_id)
  );
  CREATE TABLE onboarding_jobs (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    status       TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE onboarding_capabilities (
    job_id         TEXT NOT NULL REFERENCES onboarding_jobs(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL,
    locations_json TEXT NOT NULL,
    status         TEXT NOT NULL,
    error          TEXT,
    change_name    TEXT,
    PRIMARY KEY (job_id, name)
  );
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE artifact_approvals ADD COLUMN deps_json TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE change_meta (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    change_name  TEXT NOT NULL,
    description  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (workspace_id, change_name)
  );
  `,
  `
  ALTER TABLE onboarding_jobs ADD COLUMN error TEXT;
  ALTER TABLE onboarding_jobs ADD COLUMN discovery_run TEXT NOT NULL DEFAULT '';
  ALTER TABLE onboarding_capabilities ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  `,
  // add-visual-apply D1: a change has a planning session and an apply session.
  `
  CREATE TABLE change_sessions_v5 (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    change_name  TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan', 'apply')),
    session_id   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (workspace_id, change_name, kind)
  );
  INSERT INTO change_sessions_v5 (workspace_id, change_name, kind, session_id, created_at)
    SELECT workspace_id, change_name, 'plan', session_id, created_at FROM change_sessions;
  DROP TABLE change_sessions;
  ALTER TABLE change_sessions_v5 RENAME TO change_sessions;
  `,
  // add-visual-apply D4/D7: the tasks run in a change, in order, with their Git snapshots.
  `
  CREATE TABLE apply_tasks (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    change_name  TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    position     INTEGER NOT NULL,
    status       TEXT NOT NULL,
    before_json  TEXT NOT NULL,
    after_json   TEXT,
    summary      TEXT,
    error        TEXT,
    PRIMARY KEY (workspace_id, change_name, task_id)
  );
  `,
  // add-git-commits D2: the commits already made for a task, by repository, so a retry after
  // a partial failure does not commit twice.
  `
  ALTER TABLE apply_tasks ADD COLUMN commits_json TEXT;
  `,
  // add-change-verification D7: a change's verifications (the last finished one and the one
  // running), with the fingerprint of the code and artifacts they checked.
  `
  CREATE TABLE verifications (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    change_name      TEXT NOT NULL,
    status           TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    finished_at      TEXT,
    fingerprint_json TEXT NOT NULL,
    items_json       TEXT NOT NULL,
    error            TEXT
  );
  CREATE INDEX verifications_change ON verifications (workspace_id, change_name);
  `,
  // add-proposal-decisions D3: the decisions checkpoint of each change created by the app, and
  // what each artifact's last generation assumed and which answers it was written with.
  `
  CREATE TABLE change_decisions (
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    change_name    TEXT NOT NULL,
    status         TEXT NOT NULL,
    decisions_json TEXT NOT NULL DEFAULT '[]',
    answers_json   TEXT NOT NULL DEFAULT '[]',
    resume_auto    INTEGER NOT NULL DEFAULT 0,
    error          TEXT,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (workspace_id, change_name)
  );
  CREATE TABLE artifact_generations (
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    change_name      TEXT NOT NULL,
    artifact_id      TEXT NOT NULL,
    assumptions_json TEXT NOT NULL DEFAULT '[]',
    decisions_hash   TEXT NOT NULL,
    generated_at     TEXT NOT NULL,
    PRIMARY KEY (workspace_id, change_name, artifact_id)
  );
  `,
  // add-workspace-explore D2: conversations with the agent before a change, and their messages.
  `
  CREATE TABLE explorations (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title          TEXT,
    title_by_user  INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL,
    change_name    TEXT,
    parent_id      TEXT,
    summary        TEXT,
    draft_json     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE TABLE exploration_messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    exploration_id TEXT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
    role           TEXT NOT NULL,
    text           TEXT NOT NULL,
    status         TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX exploration_messages_by ON exploration_messages (exploration_id, id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings the schema up to `target` (the latest by default; tests stop earlier to migrate old data). */
export function migrate(db: Database, target = MIGRATIONS.length): void {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;
  for (let v = current; v < target; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

/** Opens (creating if needed) the app database and brings its schema up to date. */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
