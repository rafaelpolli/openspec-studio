import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildFixtureRoot, sandbox } from "../testing/fixture.ts";
import { CliError } from "./cli.ts";
import { OpenSpecAdapter } from "./adapter.ts";

const { dir, cli } = sandbox("studio-adapter-");
const adapter = new OpenSpecAdapter(cli);
const root = join(dir, "repo");
const t = { cwd: root };

beforeAll(() => buildFixtureRoot(root, cli), 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("reads", () => {
  test("listChanges returns active changes with task progress", async () => {
    expect(await adapter.listChanges(t)).toMatchObject([
      { name: "add-export", completedTasks: 1, totalTasks: 2 },
    ]);
  });

  test("listSpecs returns specs with requirement counts", async () => {
    expect(await adapter.listSpecs(t)).toEqual([{ id: "auth", requirementCount: 1 }]);
  });

  test("showSpec returns requirements and scenarios", async () => {
    const spec = await adapter.showSpec(t, "auth");
    expect(spec.overview).toBe("Describes how users authenticate in the existing system today.");
    expect(spec.requirements[0]).toMatchObject({ name: "Login", scenarios: [{ name: "Expired token" }] });
  });

  test("showChange returns deltas", async () => {
    const change = await adapter.showChange(t, "add-export");
    expect(change.deltas[0]).toMatchObject({ spec: "export", operation: "ADDED" });
  });

  test("status returns the artifact graph", async () => {
    const status = await adapter.status(t, "add-export");
    const byId = Object.fromEntries(status.artifacts.map((a) => [a.id, a]));
    expect(byId.proposal).toMatchObject({ status: "done", requires: [] });
    expect(byId.design).toMatchObject({ status: "ready", requires: ["proposal"] });
    expect(byId.tasks!.requires).toEqual(["specs", "design"]);
  });

  test("validate reports issues per item without throwing on an invalid change", async () => {
    const report = await adapter.validate(t, "add-export");
    expect(report.items[0]).toMatchObject({ id: "add-export", valid: false });
    expect(report.items[0]!.issues[0]!.message).toContain("at least one scenario");

    const all = await adapter.validate(t);
    expect(all.summary.totals).toEqual({ items: 2, passed: 1, failed: 1 });
  });

  test("context resolves the root", async () => {
    expect((await adapter.context(t)).root?.path).toBe(root);
  });

  test("an unknown change raises CliError with the CLI's code", async () => {
    const err = await adapter.status(t, "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("change_error");
  });

  test("a folder without OpenSpec raises no_openspec_root", async () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const err = await adapter.listChanges({ cwd: empty }).catch((e: unknown) => e);
    expect((err as CliError).code).toBe("no_openspec_root");
  });
});

describe("mutations", () => {
  const work = join(dir, "work");

  test("init creates the root with OpenCode commands and the chosen language", async () => {
    mkdirSync(work);
    await adapter.init(work, "pt-BR");
    expect(existsSync(join(work, "openspec/config.yaml"))).toBe(true);
    expect(existsSync(join(work, ".opencode/commands/opsx-propose.md"))).toBe(true);
    expect(readFileSync(join(work, "openspec/config.yaml"), "utf8")).toContain("pt-BR");
  });

  test("newChange creates a change and rejects duplicates", async () => {
    const change = await adapter.newChange({ cwd: work }, "add-thing", "Add a thing");
    expect(change).toMatchObject({ id: "add-thing", schema: "spec-driven" });
    expect(existsSync(join(change.path, ".openspec.yaml"))).toBe(true);

    const err = await adapter.newChange({ cwd: work }, "add-thing").catch((e: unknown) => e);
    expect((err as CliError).code).toBe("change_error");
  });

  test("archive moves the change and promotes its specs", async () => {
    const result = await adapter.archive(t, "add-export").catch((e: unknown) => e);
    // add-export is invalid (no scenario), so the CLI refuses it.
    expect(result).toBeInstanceOf(CliError);

    const archived = await adapter.archive({ cwd: work }, "add-thing");
    expect(archived.archivedAs).toEndWith("-add-thing");
    expect(existsSync(archived.path)).toBe(true);
  });

  test("storeSetup creates and registers a store in the isolated registry", async () => {
    const storePath = join(dir, "stores/team");
    const result = await adapter.storeSetup(dir, "team", storePath, { initGit: false });
    expect(result.store).toEqual({ id: "team", root: storePath });
    expect(result.registry.path).toStartWith(join(dir, ".xdg"));
    expect(await adapter.listStores(dir)).toEqual([{ id: "team", root: storePath }]);
    expect((await adapter.listSpecs({ cwd: dir, store: "team" }))).toEqual([]);
  });

  test("storeRegister re-registers an existing store folder with its metadata id", async () => {
    const storePath = join(dir, "stores/team");
    await cli.run(["store", "unregister", "team"], { cwd: dir });
    expect(await adapter.listStores(dir)).toEqual([]);
    const result = await adapter.storeRegister(dir, storePath);
    expect(result.store).toEqual({ id: "team", root: storePath });
    expect((await adapter.listStores(dir)).map((s) => s.id)).toEqual(["team"]);

    const err = await adapter.storeRegister(dir, storePath, "other").catch((e: unknown) => e);
    expect((err as CliError).code).toBe("store_metadata_id_mismatch");
  });
});
