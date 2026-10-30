import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFixtureRoot, sandbox } from "../testing/fixture.ts";
import { OpenSpecAdapter } from "./adapter.ts";
import { ReadCache, treeFingerprint } from "./cache.ts";

const { dir, cli } = sandbox("studio-cache-");
const root = join(dir, "repo");
const t = { cwd: root };

beforeAll(() => buildFixtureRoot(root, cli), 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ReadCache", () => {
  const scratch = join(dir, "scratch");

  test("reuses a read while the tree is unchanged and rereads after an edit", async () => {
    mkdirSync(join(scratch, "openspec"), { recursive: true });
    const file = join(scratch, "openspec", "a.md");
    writeFileSync(file, "one");
    const cache = new ReadCache();
    let calls = 0;
    const read = () => cache.get(scratch, "k", async () => ++calls);

    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    appendFileSync(file, " two");
    expect(await read()).toBe(2);
    writeFileSync(join(scratch, "openspec", "b.md"), "new file");
    expect(await read()).toBe(3);
  });

  test("shares one call between concurrent identical reads", async () => {
    const cache = new ReadCache();
    let calls = 0;
    const read = () => cache.get(scratch, "k", () => Bun.sleep(20).then(() => ++calls));
    expect(await Promise.all([read(), read(), read()])).toEqual([1, 1, 1]);
  });

  test("does not keep a failure", async () => {
    const cache = new ReadCache();
    let calls = 0;
    const read = () =>
      cache.get(scratch, "k", async () => {
        if (++calls === 1) throw new Error("boom");
        return calls;
      });
    expect(read()).rejects.toThrow("boom");
    await Bun.sleep(0);
    expect(await read()).toBe(2);
  });

  test("fingerprints a missing tree without failing", () => {
    expect(treeFingerprint(join(dir, "nowhere"))).toBe(treeFingerprint(join(dir, "nowhere-else")));
  });
});

describe("adapter with cache", () => {
  test("a repeated read does not run the CLI and an edit invalidates it", async () => {
    const adapter = new OpenSpecAdapter(cli);
    const spy = spyOn(cli, "json");
    try {
      const first = await adapter.listChanges(t);
      expect(await adapter.listChanges(t)).toEqual(first);
      await adapter.status(t, "add-export");
      await adapter.status(t, "add-export");
      expect(spy).toHaveBeenCalledTimes(2);

      const tasks = join(root, "openspec", "changes", "add-export", "tasks.md");
      appendFileSync(tasks, "- [x] 1.3 Added later\n");
      expect(await adapter.listChanges(t)).toMatchObject([{ name: "add-export", completedTasks: 2, totalTasks: 3 }]);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});
