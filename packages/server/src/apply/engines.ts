import type { Database } from "bun:sqlite";
import type { Workspace } from "@studio/shared";
import { join } from "node:path";
import type { Engine } from "../engine/engine.ts";
import { OpencodeEngine } from "../engine/opencode.ts";
import { AgentRunner } from "../engine/runner.ts";
import { ChangeSessions } from "../engine/sessions.ts";
import type { EventBus } from "../events.ts";
import { ContainerLauncher } from "./container-engine.ts";
import type { EnvironmentStore } from "./environment.ts";
import type { EnvironmentManager } from "./environments.ts";

/** Where the apply service gets the agent runner of a workspace. */
export interface RunnerSource {
  /** The runner that holds (or last held) the workspace's apply runs, without starting anything. */
  current(ws: Workspace): AgentRunner;
  /** The runner to start a task on, with its engine running; throws when the environment cannot be prepared. */
  ready(ws: Workspace): Promise<AgentRunner>;
}

/** Every workspace uses the same runner: the apply runs on the machine. */
export function fixedRunner(runner: AgentRunner): RunnerSource {
  return { current: () => runner, ready: async () => runner };
}

interface ContainerEngine {
  mode: string;
  engine: Engine;
  runner: AgentRunner;
}

/** Builds the engine of one workspace's container; a fake replaces it in tests. */
export type ContainerEngineFactory = (ws: Workspace) => Engine;

/**
 * The local engine plus one engine per workspace whose apply runs in a container
 * (add-apply-devcontainer D1). Planning and onboarding never come here: they keep the local
 * runner. A container engine is stopped with its container and dropped when the workspace
 * goes back to `local` or changes environment.
 */
export class EngineRegistry implements RunnerSource {
  readonly #engines = new Map<string, ContainerEngine>();

  constructor(
    private readonly local: AgentRunner,
    private readonly store: EnvironmentStore,
    private readonly manager: EnvironmentManager,
    private readonly db: Database,
    private readonly events: EventBus,
    private readonly makeEngine: ContainerEngineFactory,
  ) {
    manager.onStopped((workspaceId) => this.#engines.get(workspaceId)?.engine.stop());
  }

  current(ws: Workspace): AgentRunner {
    const mode = this.store.get(ws.id).mode;
    if (mode === "local") return this.local;
    return this.#engines.get(ws.id)?.runner ?? this.local;
  }

  async ready(ws: Workspace): Promise<AgentRunner> {
    const mode = this.store.get(ws.id).mode;
    const cached = this.#engines.get(ws.id);
    if (cached && cached.mode !== mode) {
      this.#engines.delete(ws.id);
      await cached.engine.stop();
    }
    if (mode === "local") return this.local;
    let entry = this.#engines.get(ws.id);
    if (!entry) {
      const engine = this.makeEngine(ws);
      entry = { mode, engine, runner: new AgentRunner(engine, new ChangeSessions(this.db, engine), this.events) };
      this.#engines.set(ws.id, entry);
    }
    // The container first: a failure here must stop the task, never fall back to the local engine.
    await this.manager.ensure(ws);
    this.manager.touch(ws.id);
    await entry.engine.ensureRunning();
    return entry.runner;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#engines.values()].map((e) => e.engine.stop()));
  }
}

/** The production factory: an embedded engine launched inside the workspace's container. */
export function containerEngineFactory(opts: {
  manager: EnvironmentManager;
  /** The local engine's auth.json. */
  authFile: string;
  version: string;
  cacheDir: string;
  config: () => Record<string, unknown>;
}): ContainerEngineFactory {
  return (ws) =>
    new OpencodeEngine({
      dataDir: opts.manager.engineDir(ws.id),
      config: opts.config,
      // Every session of a container engine is an apply session: its permission requests go to the user.
      interactive: () => true,
      launcher: new ContainerLauncher(() => ws, opts.manager, { authFile: opts.authFile, version: opts.version, cacheDir: opts.cacheDir }),
      // From `docker exec` to the listening line; the container itself is prepared before, without this limit.
      startTimeoutMs: 120_000,
    });
}

export const binaryCacheDir = (dataDir: string) => join(dataDir, "binaries");
