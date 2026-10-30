import { afterAll, describe, expect, test } from "bun:test";
import type { ServerEvent } from "@studio/shared";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../events.ts";
import { WorkspaceWatcher } from "./watcher.ts";

const root = mkdtempSync(join(tmpdir(), "studio-watch-"));
mkdirSync(join(root, "openspec/changes/add-x"), { recursive: true });
const events = new EventBus();
const watcher = new WorkspaceWatcher(events, 100);
afterAll(() => {
  watcher.close();
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WorkspaceWatcher", () => {
  test("a burst of edits produces a single workspace-changed event", async () => {
    const seen: ServerEvent[] = [];
    const off = events.subscribe((e) => seen.push(e));
    watcher.watch("ws-1", root);
    await sleep(50);

    const tasks = join(root, "openspec/changes/add-x/tasks.md");
    writeFileSync(tasks, "- [ ] 1.1 a\n");
    writeFileSync(tasks, "- [x] 1.1 a\n");
    writeFileSync(join(root, "openspec/changes/add-x/proposal.md"), "# P\n");
    await sleep(400);

    expect(seen).toEqual([{ type: "workspace-changed", workspaceId: "ws-1" }]);
    off();
  });

  test("unwatch stops events", async () => {
    const seen: ServerEvent[] = [];
    const off = events.subscribe((e) => seen.push(e));
    watcher.unwatch("ws-1");
    writeFileSync(join(root, "openspec/changes/add-x/tasks.md"), "- [ ] 1.1 b\n");
    await sleep(300);
    expect(seen).toEqual([]);
    off();
  });
});
