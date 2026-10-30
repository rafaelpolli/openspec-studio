import type { Database } from "bun:sqlite";
import type { Assumption, Decision, DecisionAnswer, DecisionCheckpoint, DecisionStatus } from "@studio/shared";
import { createHash } from "node:crypto";

interface CheckpointRow {
  status: DecisionStatus;
  decisions_json: string;
  answers_json: string;
  resume_auto: number;
  error: string | null;
}

/** What an artifact's last generation (or adjustment) assumed, and the answers it was written with. */
export interface Generation {
  assumptions: Assumption[];
  decisionsHash: string;
}

/**
 * Hash of the answers that count for the artifacts: empty when the checkpoint was skipped or
 * the change has none, so those artifacts never go "a revisar" because of decisions (D4).
 */
export function answersHash(checkpoint: DecisionCheckpoint | null): string {
  if (!checkpoint || checkpoint.status !== "respondido") return "";
  return createHash("sha256").update(JSON.stringify(checkpoint.answers)).digest("hex");
}

/** The decisions checkpoint and the artifacts' generations of each change (add-proposal-decisions D3). */
export class DecisionsRepo {
  constructor(private readonly db: Database) {}

  get(workspaceId: string, change: string): DecisionCheckpoint | null {
    const row = this.db
      .query<CheckpointRow, [string, string]>(
        "SELECT status, decisions_json, answers_json, resume_auto, error FROM change_decisions WHERE workspace_id = ? AND change_name = ?",
      )
      .get(workspaceId, change);
    if (!row) return null;
    return {
      status: row.status,
      decisions: JSON.parse(row.decisions_json) as Decision[],
      answers: JSON.parse(row.answers_json) as DecisionAnswer[],
      resumeAuto: row.resume_auto === 1,
      ...(row.error ? { error: row.error } : {}),
    };
  }

  save(workspaceId: string, change: string, c: DecisionCheckpoint): void {
    this.db
      .query(
        `INSERT INTO change_decisions (workspace_id, change_name, status, decisions_json, answers_json, resume_auto, error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, change_name) DO UPDATE SET
           status = excluded.status, decisions_json = excluded.decisions_json, answers_json = excluded.answers_json,
           resume_auto = excluded.resume_auto, error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(
        workspaceId,
        change,
        c.status,
        JSON.stringify(c.decisions),
        JSON.stringify(c.answers),
        c.resumeAuto ? 1 : 0,
        c.error ?? null,
        new Date().toISOString(),
      );
  }

  generations(workspaceId: string, change: string): Record<string, Generation> {
    const rows = this.db
      .query<{ artifact_id: string; assumptions_json: string; decisions_hash: string }, [string, string]>(
        "SELECT artifact_id, assumptions_json, decisions_hash FROM artifact_generations WHERE workspace_id = ? AND change_name = ?",
      )
      .all(workspaceId, change);
    return Object.fromEntries(
      rows.map((r) => [r.artifact_id, { assumptions: JSON.parse(r.assumptions_json) as Assumption[], decisionsHash: r.decisions_hash }]),
    );
  }

  saveGeneration(workspaceId: string, change: string, artifactId: string, g: Generation): void {
    this.db
      .query(
        `INSERT INTO artifact_generations (workspace_id, change_name, artifact_id, assumptions_json, decisions_hash, generated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, change_name, artifact_id) DO UPDATE SET
           assumptions_json = excluded.assumptions_json, decisions_hash = excluded.decisions_hash, generated_at = excluded.generated_at`,
      )
      .run(workspaceId, change, artifactId, JSON.stringify(g.assumptions), g.decisionsHash, new Date().toISOString());
  }

  /** After a restart nothing is running: a checkpoint being raised failed. */
  interruptRunning(): void {
    this.db
      .query("UPDATE change_decisions SET status = 'falhou', error = 'A aplicação foi reiniciada enquanto as decisões eram levantadas' WHERE status = 'levantando'")
      .run();
  }
}
