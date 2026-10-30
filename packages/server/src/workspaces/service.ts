import type {
  MemberIssue,
  RegisterWorkspaceInput,
  RegisterWorkspaceResult,
  Workspace,
  WorkspaceMember,
  WorkspaceView,
} from "@studio/shared";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { OpenSpecAdapter } from "../openspec/adapter.ts";
import { detectProjectType, hasOpenSpecRoot, needsInit } from "./detect.ts";
import { resolveInside } from "./paths.ts";
import type { WorkspaceRepo } from "./repo.ts";
import type { WorkspaceWatcher } from "./watcher.ts";

export class WorkspaceInputError extends Error {
  override readonly name = "WorkspaceInputError";
}

export class WorkspaceNotFoundError extends Error {
  override readonly name = "WorkspaceNotFoundError";
}

/** The workspace is not in a state that allows the action (HTTP 409). */
export class WorkspaceStateError extends Error {
  override readonly name = "WorkspaceStateError";
}

function assertDirectory(path: string): string {
  const abs = resolve(path);
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new WorkspaceInputError(`not an existing folder: ${path}`);
  return abs;
}

/** Gives each member a unique display name derived from its folder name. */
function nameMembers(paths: readonly string[]): WorkspaceMember[] {
  const used = new Map<string, number>();
  return paths.map((path) => {
    const base = basename(path);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { name: n === 1 ? base : `${base}-${n}`, path };
  });
}

const STORE_LINE = /^store:\s*.*$/m;

export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepo,
    private readonly openspec: OpenSpecAdapter,
    private readonly watcher: WorkspaceWatcher,
  ) {}

  /** Starts watching every persisted workspace; call once at startup. */
  start(): void {
    for (const ws of this.repo.list()) this.watcher.watch(ws.id, ws.rootPath);
  }

  list(): WorkspaceView[] {
    return this.repo.list().map(view);
  }

  get(id: string): Workspace {
    const ws = this.repo.get(id);
    if (!ws) throw new WorkspaceNotFoundError(`workspace not found: ${id}`);
    return ws;
  }

  view(id: string): WorkspaceView {
    return view(this.get(id));
  }

  async register(input: RegisterWorkspaceInput): Promise<RegisterWorkspaceResult> {
    const ws = input.kind === "mono" ? this.#mono(input.path, input.name) : await this.#multi(input);
    const issues = ws.kind === "multi" ? await this.memberIssues(ws) : [];
    this.repo.insert(ws);
    this.watcher.watch(ws.id, ws.rootPath);
    return { workspace: view(ws), issues };
  }

  /** Removes the workspace from the app only; nothing on disk is touched. */
  remove(id: string): void {
    if (!this.repo.delete(id)) throw new WorkspaceNotFoundError(`workspace not found: ${id}`);
    this.watcher.unwatch(id);
  }

  /** Members of a multi-repo workspace whose OpenSpec config does not point at its store. */
  async memberIssues(ws: Workspace): Promise<MemberIssue[]> {
    if (!ws.storeId) return [];
    const issues: MemberIssue[] = [];
    for (const member of ws.members) {
      const ctx = await this.openspec.context({ cwd: member.path }).catch(() => undefined);
      const declared = ctx?.root?.source === "declared" ? ctx.root.store_id : undefined;
      if (declared === ws.storeId) continue;
      issues.push(
        declared
          ? {
              member: member.name,
              issue: "declares_other_store",
              message: `${member.name} declares store '${declared}', not '${ws.storeId}'`,
            }
          : {
              member: member.name,
              issue: "store_not_declared",
              message: `${member.name} does not declare store '${ws.storeId}'`,
            },
      );
    }
    return issues;
  }

  /**
   * Writes `store: <id>` into a member's `openspec/config.yaml`, creating it if needed.
   * Called only after the user confirms (spec: workspaces, "Membro que não declara o store").
   */
  declareStore(id: string, memberName: string): void {
    const ws = this.get(id);
    if (!ws.storeId) throw new WorkspaceInputError("only multi-repo workspaces have a store");
    const member = ws.members.find((m) => m.name === memberName);
    if (!member) throw new WorkspaceInputError(`unknown member: ${memberName}`);

    const dir = join(member.path, "openspec");
    for (const sub of ["specs", "changes"]) {
      const entries = existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)) : [];
      if (entries.some((e) => !e.startsWith(".") && e !== "archive")) {
        throw new WorkspaceInputError(
          `${memberName} has its own OpenSpec ${sub}; declaring the store would hide them`,
        );
      }
    }
    const config = join(dir, "config.yaml");
    const line = `store: ${ws.storeId}`;
    if (!existsSync(config)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(config, `${line}\n`);
      return;
    }
    const current = readFileSync(config, "utf8");
    writeFileSync(config, STORE_LINE.test(current) ? current.replace(STORE_LINE, line) : `${line}\n${current}`);
  }

  /**
   * Initializes OpenSpec with the OpenCode commands and the artifact language
   * (spec: project-onboarding, "Inicializar greenfield"). A store already has its
   * config from `store setup`, and `init --language` refuses to overwrite it, so the
   * language goes into the config's `context`, as the CLI itself recommends.
   */
  async initialize(id: string, language: string): Promise<WorkspaceView> {
    const ws = this.get(id);
    if (!needsInit(ws.kind, ws.rootPath)) {
      throw new WorkspaceStateError(`${ws.name} já está inicializado com o OpenSpec; nada foi alterado`);
    }
    if (ws.kind === "mono") {
      await this.openspec.init(ws.rootPath, language);
    } else {
      await this.openspec.init(ws.rootPath);
      addLanguageContext(join(ws.rootPath, "openspec", "config.yaml"), language);
    }
    this.watcher.refresh(id);
    return view(ws);
  }

  async createStore(id: string, path: string, initGit: boolean) {
    return this.openspec.storeSetup(process.cwd(), id, resolve(path), { initGit });
  }

  /** Reads a text file inside the workspace (root or members). */
  readFile(id: string, path: string): string {
    const ws = this.get(id);
    const target = resolveInside([ws.rootPath, ...ws.members.map((m) => m.path)], path);
    return readFileSync(target, "utf8");
  }

  #mono(path: string, name: string | undefined): Workspace {
    const root = assertDirectory(path);
    const folder = basename(root);
    return {
      id: crypto.randomUUID(),
      name: name ?? folder,
      kind: "mono",
      rootPath: root,
      storeId: null,
      members: [{ name: folder, path: root }],
      createdAt: new Date().toISOString(),
    };
  }

  async #multi(input: Extract<RegisterWorkspaceInput, { kind: "multi" }>): Promise<Workspace> {
    const stores = await this.openspec.listStores(process.cwd());
    const store = stores.find((s) => s.id === input.storeId);
    if (!store) throw new WorkspaceInputError(`store is not registered on this machine: ${input.storeId}`);
    const members = input.members.map(assertDirectory);
    if (new Set(members).size !== members.length) throw new WorkspaceInputError("duplicate member folder");
    return {
      id: crypto.randomUUID(),
      name: input.name ?? store.id,
      kind: "multi",
      rootPath: store.root,
      storeId: store.id,
      members: nameMembers(members),
      createdAt: new Date().toISOString(),
    };
  }
}

function view(ws: Workspace): WorkspaceView {
  return {
    ...ws,
    projectType: detectProjectType(ws.rootPath, ws.members.map((m) => m.path)),
    hasOpenSpec: hasOpenSpecRoot(ws.rootPath),
    needsInit: needsInit(ws.kind, ws.rootPath),
  };
}

/** Adds the same language context `openspec init --language` writes, unless one exists. */
function addLanguageContext(config: string, language: string): void {
  const current = existsSync(config) ? readFileSync(config, "utf8") : "";
  if (/^context:/m.test(current)) return;
  const block = `context: |\n  Language: ${language}\n  All artifacts must be written in ${language}.\n`;
  const schemaLine = /^schema:.*\n/m;
  writeFileSync(config, schemaLine.test(current) ? current.replace(schemaLine, (l) => `${l}\n${block}`) : `${block}${current}`);
}
