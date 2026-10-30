import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "../events.ts";

interface Entry {
  watcher: FSWatcher | undefined;
  timer: Timer | undefined;
  rootPath: string;
}

/**
 * Watches each workspace's `openspec/` folder and publishes one debounced
 * `workspace-changed` event per burst of edits (design D7).
 */
export class WorkspaceWatcher {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly events: EventBus,
    private readonly debounceMs = 300,
  ) {}

  watch(workspaceId: string, rootPath: string): void {
    this.unwatch(workspaceId);
    const entry: Entry = { watcher: undefined, timer: undefined, rootPath };
    this.#entries.set(workspaceId, entry);
    this.#attach(workspaceId, entry);
  }

  /** Re-attaches after `openspec/` is created (e.g. by onboarding init). */
  refresh(workspaceId: string): void {
    const entry = this.#entries.get(workspaceId);
    if (entry && !entry.watcher) this.#attach(workspaceId, entry);
  }

  unwatch(workspaceId: string): void {
    const entry = this.#entries.get(workspaceId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.watcher?.close();
    this.#entries.delete(workspaceId);
  }

  close(): void {
    for (const id of [...this.#entries.keys()]) this.unwatch(id);
  }

  #attach(workspaceId: string, entry: Entry): void {
    const dir = join(entry.rootPath, "openspec");
    if (!existsSync(dir)) return;
    entry.watcher = watch(dir, { recursive: true }, () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.events.publish({ type: "workspace-changed", workspaceId });
      }, this.debounceMs);
    });
    entry.watcher.on("error", () => {
      entry.watcher?.close();
      entry.watcher = undefined;
    });
  }
}
