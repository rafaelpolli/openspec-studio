import {
  ArchiveResult,
  ArtifactInstructions,
  ChangeDetail,
  ChangeList,
  ChangeStatus,
  ContextReport,
  NewChangeResult,
  SpecDetail,
  SpecList,
  StoreList,
  StoreSetupResult,
  ValidationReport,
} from "@studio/shared";
import type { z } from "zod";
import { ReadCache } from "./cache.ts";
import { CliError, type OpenSpecCli } from "./cli.ts";

/** Where an OpenSpec root lives: a folder (mono-repo) or a registered store. */
export interface Target {
  cwd: string;
  store?: string | undefined;
}

/** Typed access to OpenSpec state; every call goes through the CLI (design D3). */
export class OpenSpecAdapter {
  readonly #cache: ReadCache | undefined;

  constructor(
    readonly cli: OpenSpecCli,
    opts: { cache?: boolean } = {},
  ) {
    this.#cache = opts.cache === false ? undefined : new ReadCache();
  }

  // --- reads -------------------------------------------------------------

  async listChanges(t: Target) {
    return (await this.#read(t, ["list"], ChangeList)).changes;
  }

  async listSpecs(t: Target) {
    return (await this.#read(t, ["list", "--specs"], SpecList)).specs;
  }

  showSpec(t: Target, id: string) {
    return this.#read(t, ["show", id, "--type", "spec"], SpecDetail);
  }

  showChange(t: Target, name: string) {
    return this.#read(t, ["show", name, "--type", "change"], ChangeDetail);
  }

  status(t: Target, change: string) {
    return this.#read(t, ["status", "--change", change], ChangeStatus);
  }

  /** Validates one change or spec, or everything when `item` is omitted. */
  validate(t: Target, item?: string) {
    const args = item ? ["validate", item] : ["validate", "--all"];
    return this.#read(t, args, ValidationReport, { allowNonZero: true });
  }

  instructions(t: Target, change: string, artifactId: string) {
    return this.#read(t, ["instructions", artifactId, "--change", change], ArtifactInstructions);
  }

  context(t: Target) {
    return this.#read(t, ["context"], ContextReport);
  }

  async listStores(cwd: string) {
    return (await this.cli.json(["store", "list"], StoreList, { cwd })).stores;
  }

  /** A CLI read, memoized while the root's `openspec/` tree is unchanged. */
  #read<S extends z.ZodType>(t: Target, args: string[], schema: S, extra: { allowNonZero?: boolean } = {}) {
    const run = () => this.cli.json(args, schema, { ...t, ...extra });
    if (!this.#cache) return run();
    return this.#cache.get(t.cwd, JSON.stringify([t.store ?? null, args]), run);
  }

  // --- mutations ---------------------------------------------------------

  async newChange(t: Target, name: string, description?: string) {
    const args = ["new", "change", name, ...(description ? ["--description", description] : [])];
    return (await this.cli.json(args, NewChangeResult, t)).change;
  }

  async archive(t: Target, name: string) {
    return (await this.cli.json(["archive", name, "-y"], ArchiveResult, t)).archive;
  }

  /**
   * Initializes OpenSpec in `cwd` with the OpenCode commands. `init` has no JSON output.
   * Without `language` it only installs the commands into an existing root (a store).
   */
  async init(cwd: string, language?: string) {
    const lang = language ? ["--language", language] : [];
    const result = await this.cli.run(["init", "--tools", "opencode", ...lang, "--no-animation"], { cwd });
    if (result.exitCode !== 0) {
      throw new CliError(result.stderr.trim() || "openspec init failed", "exit_code", undefined, result.stderr);
    }
  }

  storeSetup(cwd: string, id: string, path: string, opts: { initGit?: boolean } = {}) {
    const args = ["store", "setup", id, "--path", path, opts.initGit === false ? "--no-init-git" : "--init-git"];
    return this.cli.json(args, StoreSetupResult, { cwd });
  }

  storeRegister(cwd: string, path: string, id?: string) {
    const args = ["store", "register", path, "--yes", ...(id ? ["--id", id] : [])];
    return this.cli.json(args, StoreSetupResult, { cwd });
  }
}
