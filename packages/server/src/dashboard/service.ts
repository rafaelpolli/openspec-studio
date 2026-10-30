import type { ArtifactFile, SpecOverview, SystemStatus, TaskChecklist, Workspace } from "@studio/shared";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Target } from "../openspec/adapter.ts";
import type { OpenSpecAdapter } from "../openspec/adapter.ts";
import { parseTasks } from "../openspec/tasks.ts";
import { resolveInside } from "../workspaces/paths.ts";
import { WorkspaceInputError, type WorkspaceService } from "../workspaces/service.ts";

const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Read-only OpenSpec views for the dashboard (spec: spec-dashboard). */
export class DashboardService {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly openspec: OpenSpecAdapter,
  ) {}

  async system(): Promise<SystemStatus> {
    try {
      return { openspec: { available: true, version: await this.openspec.cli.assertVersion() } };
    } catch (err) {
      return { openspec: { available: false, message: (err as Error).message } };
    }
  }

  async specs(id: string): Promise<SpecOverview[]> {
    const t = this.#target(id);
    const specs = await this.openspec.listSpecs(t);
    return Promise.all(
      specs.map(async (s) => ({
        id: s.id,
        purpose: (await this.openspec.showSpec(t, s.id)).overview,
        requirementCount: s.requirementCount,
      })),
    );
  }

  spec(id: string, specId: string) {
    return this.openspec.showSpec(this.#target(id), specId);
  }

  changes(id: string) {
    return this.openspec.listChanges(this.#target(id));
  }

  status(id: string, change: string) {
    return this.openspec.status(this.#target(id), this.#changeName(change));
  }

  /** Contents of an artifact's existing files (several for glob artifacts such as specs). */
  async artifact(id: string, change: string, artifactId: string): Promise<ArtifactFile[]> {
    const status = await this.status(id, change);
    const paths = status.artifactPaths[artifactId];
    if (!paths) return [];
    const ws = this.workspaces.get(id);
    return paths.existingOutputPaths.map((file) => {
      const safe = resolveInside([ws.rootPath], file);
      return { path: relative(status.changeRoot, safe), content: readFileSync(safe, "utf8") };
    });
  }

  async tasks(id: string, change: string): Promise<TaskChecklist> {
    const status = await this.status(id, change);
    const file = join(status.changeRoot, "tasks.md");
    const ws = this.workspaces.get(id);
    const safe = resolveInside([ws.rootPath], file);
    return existsSync(safe) ? parseTasks(readFileSync(safe, "utf8")) : { sections: [], total: 0, complete: 0 };
  }

  validate(id: string, item?: string) {
    return this.openspec.validate(this.#target(id), item);
  }

  #target(id: string): Target {
    const ws: Workspace = this.workspaces.get(id);
    return { cwd: ws.rootPath, store: ws.storeId ?? undefined };
  }

  #changeName(name: string): string {
    if (!CHANGE_NAME.test(name)) throw new WorkspaceInputError(`invalid change name: ${name}`);
    return name;
  }
}
