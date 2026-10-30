import type { Database } from "bun:sqlite";
import type { Workspace, WorkspaceKind, WorkspaceMember } from "@studio/shared";

interface WorkspaceRow {
  id: string;
  name: string;
  kind: WorkspaceKind;
  root_path: string;
  store_id: string | null;
  created_at: string;
}

/** Persistence for registered workspaces (SQLite, see design D6). */
export class WorkspaceRepo {
  constructor(private readonly db: Database) {}

  insert(ws: Workspace): void {
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(ws.id, ws.name, ws.kind, ws.rootPath, ws.storeId, ws.createdAt);
      const member = this.db.query(
        "INSERT INTO workspace_members (workspace_id, name, path, position) VALUES (?, ?, ?, ?)",
      );
      ws.members.forEach((m, i) => member.run(ws.id, m.name, m.path, i));
    })();
  }

  list(): Workspace[] {
    const rows = this.db.query<WorkspaceRow, []>("SELECT * FROM workspaces ORDER BY created_at, id").all();
    return rows.map((row) => this.#hydrate(row));
  }

  get(id: string): Workspace | undefined {
    const row = this.db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? this.#hydrate(row) : undefined;
  }

  delete(id: string): boolean {
    return this.db.query("DELETE FROM workspaces WHERE id = ?").run(id).changes > 0;
  }

  #hydrate(row: WorkspaceRow): Workspace {
    const members = this.db
      .query<WorkspaceMember, [string]>(
        "SELECT name, path FROM workspace_members WHERE workspace_id = ? ORDER BY position",
      )
      .all(row.id);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      rootPath: row.root_path,
      storeId: row.store_id,
      members,
      createdAt: row.created_at,
    };
  }
}
