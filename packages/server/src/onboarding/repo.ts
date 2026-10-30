import type { Database } from "bun:sqlite";
import type { Capability, CapabilityDraft, CapabilityStatus, OnboardingJob, OnboardingStatus } from "@studio/shared";

interface JobRow {
  id: string;
  workspace_id: string;
  status: OnboardingStatus;
  error: string | null;
  discovery_run: string;
  created_at: string;
}

interface CapabilityRow {
  name: string;
  description: string;
  locations_json: string;
  status: CapabilityStatus;
  error: string | null;
  change_name: string | null;
}

/** Onboarding jobs and their capabilities in SQLite, so a batch survives restarts (design D9). */
export class OnboardingRepo {
  constructor(private readonly db: Database) {}

  create(workspaceId: string): OnboardingJob {
    const id = crypto.randomUUID();
    const discoveryRun = `descoberta-${id.slice(0, 8)}`;
    this.db
      .query(
        "INSERT INTO onboarding_jobs (id, workspace_id, status, error, discovery_run, created_at) VALUES (?, ?, 'descobrindo', NULL, ?, ?)",
      )
      .run(id, workspaceId, discoveryRun, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): OnboardingJob | undefined {
    const row = this.db.query<JobRow, [string]>("SELECT * FROM onboarding_jobs WHERE id = ?").get(id);
    return row ? this.#job(row) : undefined;
  }

  /** The workspace's most recent job. */
  latest(workspaceId: string): OnboardingJob | undefined {
    const row = this.db
      .query<JobRow, [string]>("SELECT * FROM onboarding_jobs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(workspaceId);
    return row ? this.#job(row) : undefined;
  }

  /** Jobs whose batch is still generating (to resume after a restart). */
  generating(): OnboardingJob[] {
    return this.db
      .query<JobRow, []>("SELECT * FROM onboarding_jobs WHERE status = 'gerando' ORDER BY created_at")
      .all()
      .map((r) => this.#job(r));
  }

  setStatus(id: string, status: OnboardingStatus, error: string | null = null): void {
    this.db.query("UPDATE onboarding_jobs SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }

  /** Replaces the capability list (discovery result or checkpoint edit). */
  setCapabilities(id: string, caps: readonly CapabilityDraft[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM onboarding_capabilities WHERE job_id = ?").run(id);
      const insert = this.db.query(
        `INSERT INTO onboarding_capabilities (job_id, name, description, locations_json, status, error, change_name, position)
         VALUES (?, ?, ?, ?, 'aguardando', NULL, NULL, ?)`,
      );
      caps.forEach((c, i) => insert.run(id, c.name, c.description, JSON.stringify(c.locations), i));
    })();
  }

  updateCapability(
    id: string,
    name: string,
    patch: { status?: CapabilityStatus; error?: string | null; changeName?: string | null },
  ): void {
    const current = this.get(id)?.capabilities.find((c) => c.name === name);
    if (!current) return;
    this.db
      .query("UPDATE onboarding_capabilities SET status = ?, error = ?, change_name = ? WHERE job_id = ? AND name = ?")
      .run(
        patch.status ?? current.status,
        patch.error === undefined ? current.error : patch.error,
        patch.changeName === undefined ? current.changeName : patch.changeName,
        id,
        name,
      );
  }

  /** After a restart, nothing is generating any more: put interrupted capabilities back in the queue. */
  requeueInterrupted(): void {
    this.db
      .query("UPDATE onboarding_capabilities SET status = 'aguardando', error = NULL WHERE status IN ('gerando', 'validando')")
      .run();
  }

  /** A discovery session does not survive a restart; the user can start it again. */
  failInterruptedDiscovery(): void {
    this.db
      .query("UPDATE onboarding_jobs SET status = 'descoberta_falhou', error = ? WHERE status = 'descobrindo'")
      .run("a descoberta foi interrompida por um reinício do backend");
  }

  #job(row: JobRow): OnboardingJob {
    const caps = this.db
      .query<CapabilityRow, [string]>("SELECT * FROM onboarding_capabilities WHERE job_id = ? ORDER BY position")
      .all(row.id)
      .map(
        (c): Capability => ({
          name: c.name,
          description: c.description,
          locations: JSON.parse(c.locations_json),
          status: c.status,
          error: c.error,
          changeName: c.change_name,
        }),
      );
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      status: row.status,
      error: row.error,
      discoveryRun: row.discovery_run,
      capabilities: caps,
      createdAt: row.created_at,
    };
  }
}
