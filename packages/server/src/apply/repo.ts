import type { Database } from "bun:sqlite";
import type { ApplyTaskStatus } from "@studio/shared";

/** A task that has run (or is running) in a change, in the order it started. */
export interface TaskEntry {
  taskId: string;
  position: number;
  status: Extract<ApplyTaskStatus, "rodando" | "aguardando-permissao" | "aguardando-revisao" | "aceita" | "incompleta">;
  /** Member path → snapshot tree before the task (members in Git only). */
  before: Record<string, string>;
  /** Member path → snapshot tree when the task (or its last adjustment) finished. */
  after?: Record<string, string>;
  summary?: string;
  error?: string;
  /** Repository top → commit made by "Aceitar e commitar" (add-git-commits D2). */
  commits?: Record<string, string>;
}

interface Row {
  task_id: string;
  position: number;
  status: TaskEntry["status"];
  before_json: string;
  after_json: string | null;
  summary: string | null;
  error: string | null;
  commits_json: string | null;
}

/** The apply history of each change, kept in SQLite so a review survives a restart. */
export class ApplyRepo {
  constructor(private readonly db: Database) {}

  list(workspaceId: string, change: string): TaskEntry[] {
    return this.db
      .query<Row, [string, string]>(
        "SELECT * FROM apply_tasks WHERE workspace_id = ? AND change_name = ? ORDER BY position",
      )
      .all(workspaceId, change)
      .map((r) => ({
        taskId: r.task_id,
        position: r.position,
        status: r.status,
        before: JSON.parse(r.before_json),
        ...(r.after_json ? { after: JSON.parse(r.after_json) } : {}),
        ...(r.summary ? { summary: r.summary } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(r.commits_json ? { commits: JSON.parse(r.commits_json) } : {}),
      }));
  }

  save(workspaceId: string, change: string, e: TaskEntry): void {
    this.db
      .query(
        `INSERT INTO apply_tasks (workspace_id, change_name, task_id, position, status, before_json, after_json, summary, error, commits_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, change_name, task_id) DO UPDATE SET
           position = excluded.position, status = excluded.status, before_json = excluded.before_json,
           after_json = excluded.after_json, summary = excluded.summary, error = excluded.error,
           commits_json = excluded.commits_json`,
      )
      .run(
        workspaceId,
        change,
        e.taskId,
        e.position,
        e.status,
        JSON.stringify(e.before),
        e.after ? JSON.stringify(e.after) : null,
        e.summary ?? null,
        e.error ?? null,
        e.commits && Object.keys(e.commits).length > 0 ? JSON.stringify(e.commits) : null,
      );
  }

  remove(workspaceId: string, change: string, taskId: string): void {
    this.db
      .query("DELETE FROM apply_tasks WHERE workspace_id = ? AND change_name = ? AND task_id = ?")
      .run(workspaceId, change, taskId);
  }

  /** Forgets the change's apply history, once it is archived (add-change-verification D10). */
  removeChange(workspaceId: string, change: string): void {
    this.db.query("DELETE FROM apply_tasks WHERE workspace_id = ? AND change_name = ?").run(workspaceId, change);
  }

  /** True when a task of the workspace ran and still waits for review or undo (add-git-commits). */
  hasOpen(workspaceId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM apply_tasks WHERE workspace_id = ?
           AND status IN ('rodando', 'aguardando-permissao', 'aguardando-revisao', 'incompleta')`,
        )
        .get(workspaceId)!.n > 0
    );
  }

  /** After a restart nothing is running: a task that was running becomes incomplete. */
  interruptRunning(): void {
    this.db
      .query(
        `UPDATE apply_tasks SET status = 'incompleta', error = 'A aplicação foi reiniciada durante a task'
         WHERE status IN ('rodando', 'aguardando-permissao')`,
      )
      .run();
  }
}
