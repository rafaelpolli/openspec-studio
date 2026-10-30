import type { Database } from "bun:sqlite";
import type { VerificationItem, VerificationReport, VerificationStatus } from "@studio/shared";
import { verdictOf } from "@studio/shared";

/** A verification as stored: the report plus the fingerprint of what it checked (D7). */
export interface VerificationRecord extends VerificationReport {
  workspaceId: string;
  /** Member path → tree of its files, plus `artifacts` → hash of the change's artifacts. */
  fingerprint: Record<string, string>;
}

interface Row {
  id: string;
  workspace_id: string;
  change_name: string;
  status: VerificationStatus;
  created_at: string;
  finished_at: string | null;
  fingerprint_json: string;
  items_json: string;
  error: string | null;
}

function toRecord(r: Row): VerificationRecord {
  const items = JSON.parse(r.items_json) as VerificationItem[];
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    change: r.change_name,
    status: r.status,
    createdAt: r.created_at,
    ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
    items,
    ...(r.status === "concluida" ? { verdict: verdictOf(items) } : {}),
    ...(r.error ? { error: r.error } : {}),
    fingerprint: JSON.parse(r.fingerprint_json),
  };
}

/** The verifications of each change: only the last finished one and the latest attempt are kept. */
export class VerificationRepo {
  constructor(private readonly db: Database) {}

  create(workspaceId: string, change: string, fingerprint: Record<string, string>): VerificationRecord {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO verifications (id, workspace_id, change_name, status, created_at, fingerprint_json, items_json)
         VALUES (?, ?, ?, 'rodando', ?, ?, '[]')`,
      )
      .run(id, workspaceId, change, new Date().toISOString(), JSON.stringify(fingerprint));
    return this.get(id)!;
  }

  get(id: string): VerificationRecord | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM verifications WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  save(v: VerificationRecord): void {
    this.db
      .query("UPDATE verifications SET status = ?, finished_at = ?, items_json = ?, error = ? WHERE id = ?")
      .run(v.status, v.finishedAt ?? null, JSON.stringify(v.items), v.error ?? null, v.id);
  }

  /** The attempt running now, if any. */
  running(workspaceId: string, change: string): VerificationRecord | undefined {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM verifications WHERE workspace_id = ? AND change_name = ? AND status = 'rodando' ORDER BY created_at DESC LIMIT 1",
      )
      .get(workspaceId, change);
    return row ? toRecord(row) : undefined;
  }

  /** The last verification that finished with a report. */
  latest(workspaceId: string, change: string): VerificationRecord | undefined {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM verifications WHERE workspace_id = ? AND change_name = ? AND status = 'concluida' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(workspaceId, change);
    return row ? toRecord(row) : undefined;
  }

  /** The most recent attempt of any status, for its error. */
  lastAttempt(workspaceId: string, change: string): VerificationRecord | undefined {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM verifications WHERE workspace_id = ? AND change_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(workspaceId, change);
    return row ? toRecord(row) : undefined;
  }

  /** Whether a verification runs anywhere in the workspace. */
  hasRunning(workspaceId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM verifications WHERE workspace_id = ? AND status = 'rodando'")
        .get(workspaceId)!.n > 0
    );
  }

  /** Drops the change's older rows: keeps the last finished report and the latest attempt. */
  prune(workspaceId: string, change: string): void {
    const keep = [this.latest(workspaceId, change)?.id, this.lastAttempt(workspaceId, change)?.id].filter((x): x is string => !!x);
    this.db
      .query(`DELETE FROM verifications WHERE workspace_id = ? AND change_name = ? AND id NOT IN (${keep.map(() => "?").join(", ") || "''"})`)
      .run(workspaceId, change, ...keep);
  }

  removeChange(workspaceId: string, change: string): void {
    this.db.query("DELETE FROM verifications WHERE workspace_id = ? AND change_name = ?").run(workspaceId, change);
  }

  /** After a restart nothing is running: a running verification is interrupted. */
  interruptRunning(): void {
    this.db
      .query("UPDATE verifications SET status = 'interrompida', error = 'A aplicação foi reiniciada durante a verificação' WHERE status = 'rodando'")
      .run();
  }
}
