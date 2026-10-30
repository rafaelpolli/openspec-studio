import type { GitState, InitPreview } from "@studio/shared";
import type { EventBus } from "../events.ts";
import type { WorkspaceService } from "../workspaces/service.ts";
import { commitPending } from "./commit.ts";
import { GitStateError, type GitClient } from "./exec.ts";
import { init, previewInit } from "./init.ts";
import { areaState, clearIdentity, findArea, gitAreas, setIdentity } from "./repo.ts";

/**
 * The Git of a workspace's members and store, as the app does it (spec: git-repositories).
 * `busy` tells whether a task of the workspace runs or waits for review; `verifying`, whether a
 * change of it is being verified (add-change-verification).
 */
export class GitService {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly git: GitClient,
    private readonly events: EventBus,
    private readonly busy: (workspaceId: string) => boolean = () => false,
    private readonly verifying: (workspaceId: string) => boolean = () => false,
  ) {}

  async state(workspaceId: string): Promise<GitState> {
    const ws = this.workspaces.get(workspaceId);
    const areas = await Promise.all(gitAreas(ws).map((a) => areaState(this.git, a)));
    return { areas, busy: this.busy(workspaceId) || this.verifying(workspaceId) };
  }

  async setIdentity(workspaceId: string, path: string, name: string, email: string): Promise<GitState> {
    const area = findArea(this.workspaces.get(workspaceId), path);
    await setIdentity(this.git, area.path, name, email);
    return this.#changed(workspaceId);
  }

  async clearIdentity(workspaceId: string, path: string): Promise<GitState> {
    const area = findArea(this.workspaces.get(workspaceId), path);
    await clearIdentity(this.git, area.path);
    return this.#changed(workspaceId);
  }

  async previewInit(workspaceId: string, path: string, gitignore?: string): Promise<InitPreview> {
    const area = findArea(this.workspaces.get(workspaceId), path);
    return previewInit(this.git, area.path, gitignore);
  }

  async init(
    workspaceId: string,
    path: string,
    opts: { gitignore: string; message: string; noVerify?: boolean; identity?: { name: string; email: string } },
  ): Promise<GitState> {
    const area = findArea(this.workspaces.get(workspaceId), path);
    await init(this.git, area.path, opts);
    return this.#changed(workspaceId);
  }

  /** Unavailable while a task runs or waits for review, so the agent's work is not mixed in (spec: "Commitar pendências"). */
  async commitPending(workspaceId: string, path: string, opts: { message: string; noVerify?: boolean }): Promise<GitState> {
    const area = findArea(this.workspaces.get(workspaceId), path);
    if (this.busy(workspaceId)) {
      throw new GitStateError("há uma task rodando ou aguardando revisão: aceite ou desfaça a task antes de commitar as pendências");
    }
    if (this.verifying(workspaceId)) {
      throw new GitStateError("uma change deste workspace está sendo verificada: espere a verificação terminar para commitar as pendências");
    }
    await commitPending(this.git, area.path, opts);
    return this.#changed(workspaceId);
  }

  async #changed(workspaceId: string): Promise<GitState> {
    this.events.publish({ type: "git-changed", workspaceId });
    return this.state(workspaceId);
  }
}
