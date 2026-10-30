import type { Database } from "bun:sqlite";
import type { SessionKind } from "@studio/shared";
import type { Engine, PermissionRule } from "./engine.ts";

export interface ChangeSession {
  sessionId: string;
  /** False when a previous session existed but the engine no longer has it. */
  historyAvailable: boolean;
  /** True when this call created the session. */
  created: boolean;
}

/**
 * One planning session per change, reused for every step and adjustment of its artifacts,
 * and one apply session, reused for every task (spec: agent-sessions, "Uma sessão por
 * change"). They differ in permissions, which are fixed when a session is created. The
 * mapping lives in SQLite so it survives restarts.
 */
export class ChangeSessions {
  constructor(
    private readonly db: Database,
    private readonly engine: Engine,
  ) {}

  stored(workspaceId: string, change: string, kind: SessionKind = "plan"): string | undefined {
    return this.db
      .query<{ session_id: string }, [string, string, string]>(
        "SELECT session_id FROM change_sessions WHERE workspace_id = ? AND change_name = ? AND kind = ?",
      )
      .get(workspaceId, change, kind)?.session_id;
  }

  /** Finds which change a session belongs to (to route agent events). */
  owner(sessionId: string): { workspaceId: string; change: string; kind: SessionKind } | undefined {
    const row = this.db
      .query<{ workspace_id: string; change_name: string; kind: SessionKind }, [string]>(
        "SELECT workspace_id, change_name, kind FROM change_sessions WHERE session_id = ?",
      )
      .get(sessionId);
    return row ? { workspaceId: row.workspace_id, change: row.change_name, kind: row.kind } : undefined;
  }

  /** Returns the change's session, reusing the stored one when the engine still has it. */
  async forChange(
    workspaceId: string,
    change: string,
    directory: string,
    permission?: PermissionRule[],
    kind: SessionKind = "plan",
  ): Promise<ChangeSession> {
    const previous = this.stored(workspaceId, change, kind);
    if (previous && (await this.engine.sessionExists(previous, directory))) {
      return { sessionId: previous, historyAvailable: true, created: false };
    }
    const title = kind === "apply" ? `${change} (apply)` : change;
    const sessionId = await this.engine.createSession({ directory, title, ...(permission ? { permission } : {}) });
    this.db
      .query(
        `INSERT INTO change_sessions (workspace_id, change_name, kind, session_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, change_name, kind) DO UPDATE SET session_id = excluded.session_id, created_at = excluded.created_at`,
      )
      .run(workspaceId, change, kind, sessionId, new Date().toISOString());
    return { sessionId, historyAvailable: previous === undefined, created: true };
  }

  /** True for an apply session, whose permission requests go to the user (add-visual-apply D3). */
  isApply(sessionId: string): boolean {
    return this.owner(sessionId)?.kind === "apply";
  }

  /** Forgets every session of the change. */
  forget(workspaceId: string, change: string): void {
    this.db.query("DELETE FROM change_sessions WHERE workspace_id = ? AND change_name = ?").run(workspaceId, change);
  }
}
