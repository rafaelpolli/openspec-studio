import type {
  ApplyState,
  ApplyTask,
  MemberDiff,
  TaskCommit,
  MemberWarning,
  PermissionReply,
  RunView,
  TaskItem,
  Workspace,
  WorkspaceMember,
} from "@studio/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { applyPermissions } from "../engine/guard.ts";
import type { AgentRunner } from "../engine/runner.ts";
import type { RunnerSource } from "./engines.ts";
import type { OpenSpecAdapter, Target } from "../openspec/adapter.ts";
import { parseTasks } from "../openspec/tasks.ts";
import type { WorkspaceService } from "../workspaces/service.ts";
import type { CommandList } from "./commands.ts";
import { buildTaskAdjustPrompt, buildTaskPrompt } from "./prompt.ts";
import type { ApplyRepo, TaskEntry } from "./repo.ts";
import { commitTree, type TreeFile } from "../git/commit.ts";
import { GitClient } from "../git/exec.ts";
import { diffSnapshots, dirtyBefore, gitState, repoTop, restore, snapshot } from "./snapshot.ts";
import { changeScenarios } from "../verification/scenarios.ts";

/** An action that does not fit the apply's current state (HTTP 409). */
export class ApplyStateError extends Error {
  override readonly name = "ApplyStateError";
}

/** Raised when the members need the user's confirmation before a run (HTTP 409 with the warnings). */
export class ApplyConfirmationError extends ApplyStateError {
  constructor(readonly warnings: MemberWarning[]) {
    super("confirme os avisos dos membros antes de executar");
  }
}

export type ReplyChoice = PermissionReply | "always";

interface Queue {
  change: string;
  /** "todas" keeps going after each task reaches review; "proxima" stops after one. */
  mode: "proxima" | "todas";
  stopped: boolean;
  done: Promise<void>;
}

/** A folder whose files a task may change: a member, or the root's `openspec/` in a multi-repo. */
interface Area {
  name: string;
  path: string;
}

/** One repository's part of a task's commit (add-git-commits D2). */
interface CommitGroup {
  top: string;
  label: string;
  files: TreeFile[];
  /** The change's tasks.md is in this repository and goes into its commit. */
  tasks: boolean;
}

/** Statuses of a task whose result is still open: later tasks were computed on top of it. */
const OPEN: readonly TaskEntry["status"][] = ["rodando", "aguardando-permissao", "aguardando-revisao", "incompleta"];

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const taskId = (t: TaskItem) => t.id ?? `linha-${t.line}`;

/**
 * Runs a change's tasks with the agent, one apply-session prompt per task, and keeps each
 * task's result for review: accept marks it in tasks.md, adjust re-prompts, undo restores
 * the files from the task's Git snapshot (spec: change-apply; design add-visual-apply).
 */
export class ApplyService {
  /** One run at a time per workspace (D7). */
  readonly #queues = new Map<string, Queue>();

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly openspec: OpenSpecAdapter,
    private readonly runners: RunnerSource,
    private readonly repo: ApplyRepo,
    private readonly commands: CommandList,
    private readonly git: GitClient = new GitClient(),
    /** A change of the workspace is being verified: no task starts meanwhile (add-change-verification). */
    private readonly verifying: (workspaceId: string) => boolean = () => false,
  ) {}

  start(): void {
    this.repo.interruptRunning();
  }

  // --- state -------------------------------------------------------------

  async state(workspaceId: string, change: string): Promise<ApplyState> {
    const ws = this.workspaces.get(workspaceId);
    const tasksFile = this.#tasksFile(ws, change);
    const run = this.runners.current(ws).view(workspaceId, change, "apply");
    const queue = this.#queues.get(workspaceId);
    const running = queue?.change === change;
    if (!existsSync(tasksFile)) return { change, hasTasks: false, running, tasks: [], ...(run ? { run } : {}) };

    const history = this.repo.list(workspaceId, change);
    const entries = new Map(history.map((e) => [e.taskId, e]));
    const last = history.at(-1);
    const areas = this.#areas(ws);
    const checklist = parseTasks(readFileSync(tasksFile, "utf8"));
    const tasks: ApplyTask[] = checklist.sections.flatMap((section) =>
      section.tasks.map((t) => {
        const id = taskId(t);
        const entry = entries.get(id);
        const base = { id, text: t.text, section: section.title };
        if (!entry) {
          const queued = running && queue?.mode === "todas" && !queue.stopped;
          return { ...base, status: t.done ? ("aceita" as const) : queued ? ("na-fila" as const) : ("pendente" as const) };
        }
        const status = entry.status === "rodando" && run?.permission ? ("aguardando-permissao" as const) : entry.status;
        const diff = entry.after ? this.#diff(areas, entry, tasksFile, run) : undefined;
        const commit = entry.status === "aguardando-revisao" && diff ? this.#commitInfo(change, t.text, areas, diff, entry, history, tasksFile) : undefined;
        return {
          ...base,
          status,
          ...(entry.summary ? { summary: entry.summary } : {}),
          ...(entry.error ? { error: entry.error } : {}),
          ...(diff ? { diff } : {}),
          ...(commit ? { commit } : {}),
          ...(entry === last && (entry.status === "aguardando-revisao" || entry.status === "incompleta") && !running
            ? { canUndo: true }
            : {}),
        };
      }),
    );
    return {
      change,
      hasTasks: true,
      running,
      tasks,
      ...(run ? { run } : {}),
      ...(run?.permission ? { permission: run.permission } : {}),
    };
  }

  /** Members to warn about before running (spec: "Git como rede de segurança"). */
  check(workspaceId: string): MemberWarning[] {
    const ws = this.workspaces.get(workspaceId);
    return this.#areas(ws).flatMap((a): MemberWarning[] => {
      const st = gitState(a.path);
      if (!st.git) return [{ member: a.name, kind: "sem-git" as const }];
      return st.dirty ? [{ member: a.name, kind: "alteracoes-pendentes" as const }] : [];
    });
  }

  // --- run ---------------------------------------------------------------

  async run(workspaceId: string, change: string, mode: Queue["mode"], confirmed: boolean): Promise<ApplyState> {
    const ws = this.workspaces.get(workspaceId);
    const current = this.#queues.get(workspaceId);
    if (current) throw new ApplyStateError(`o apply de ${current.change} já está em andamento neste workspace`);
    if (this.verifying(workspaceId)) throw new ApplyStateError("a change está sendo verificada: espere a verificação terminar ou pare-a");
    if (!existsSync(this.#tasksFile(ws, change))) throw new ApplyStateError("a change ainda não tem tasks.md");
    if (this.#pending(ws, change).length === 0) throw new ApplyStateError("não há tasks pendentes");
    const warnings = this.check(workspaceId);
    if (warnings.length > 0 && !confirmed) throw new ApplyConfirmationError(warnings);

    const queue: Queue = { change, mode, stopped: false, done: Promise.resolve() };
    this.#queues.set(workspaceId, queue);
    queue.done = this.#loop(ws, queue).finally(() => this.#queues.delete(workspaceId));
    return this.state(workspaceId, change);
  }

  async stop(workspaceId: string, change: string): Promise<ApplyState> {
    const queue = this.#queues.get(workspaceId);
    if (queue?.change === change) queue.stopped = true;
    await this.runners.current(this.workspaces.get(workspaceId)).cancel(workspaceId, change, "apply");
    await queue?.done;
    return this.state(workspaceId, change);
  }

  /** A task of the workspace runs or waits for review: the user's own commits wait (add-git-commits). */
  busy(workspaceId: string): boolean {
    return this.#queues.has(workspaceId) || this.repo.hasOpen(workspaceId);
  }

  /** Waits for the workspace's queue to finish (tests and shutdown). */
  async settled(workspaceId: string): Promise<void> {
    await this.#queues.get(workspaceId)?.done;
  }

  async #loop(ws: Workspace, queue: Queue): Promise<void> {
    // A container that cannot be prepared leaves the tasks as they were; the environment
    // status carries the error (spec: apply-environment, "Falha do ambiente").
    const runner = await this.runners.ready(ws).catch(() => undefined);
    if (!runner) return;
    while (!queue.stopped) {
      const next = this.#pending(ws, queue.change)[0];
      if (!next) return;
      const status = await this.#runTask(ws, queue.change, next, runner);
      if (status !== "aguardando-revisao" || queue.mode === "proxima") return;
    }
  }

  async #runTask(ws: Workspace, change: string, task: { id: string; text: string; section: string | null }, runner: AgentRunner) {
    const areas = this.#areas(ws);
    const entry: TaskEntry = {
      taskId: task.id,
      position: Date.now(),
      status: "rodando",
      before: this.#snapshots(areas),
    };
    this.repo.save(ws.id, change, entry);
    const tasksFile = this.#tasksFile(ws, change);
    const text = buildTaskPrompt({
      change,
      task,
      contextFiles: await this.#contextFiles(ws, change),
      tasksFile,
      members: ws.members,
      commands: this.commands.get(ws),
      scenarios: changeScenarios(dirname(tasksFile)),
    });
    return this.#prompt(ws, change, entry, text, runner);
  }

  /** Runs one prompt on the change's apply session and records the outcome on `entry`. */
  async #prompt(ws: Workspace, change: string, entry: TaskEntry, text: string, runner: AgentRunner): Promise<TaskEntry["status"]> {
    const tasksFile = this.#tasksFile(ws, change);
    const areas = this.#areas(ws);
    let run: RunView;
    try {
      const handle = await runner.start({
        workspaceId: ws.id,
        change,
        kind: "apply",
        directory: ws.rootPath,
        text,
        permission: applyPermissions({
          root: ws.rootPath,
          members: ws.members.map((m) => m.path),
          tasksFile,
          commands: this.commands.get(ws),
        }),
        fileRoots: [ws.rootPath, ...ws.members.map((m) => m.path)],
      });
      // "Parar" may have come while the session was being prepared.
      if (this.#queues.get(ws.id)?.stopped) await runner.cancel(ws.id, change, "apply");
      run = await handle.done;
    } catch (err) {
      run = { status: "falhou", error: { kind: "outro", message: (err as Error).message } } as RunView;
    }
    entry.after = this.#snapshots(areas);
    delete entry.error;
    if (run.status === "concluido") {
      entry.status = "aguardando-revisao";
      const summary = run.transcript?.at(-1)?.text.trim();
      if (summary) entry.summary = summary;
    } else {
      entry.status = "incompleta";
      entry.error = run.status === "cancelado" ? "A task foi interrompida" : (run.error?.message ?? "O agente falhou");
    }
    this.repo.save(ws.id, change, entry);
    return entry.status;
  }

  // --- review ------------------------------------------------------------

  /**
   * Marks the task in tasks.md; with `commit`, also commits the task's files in each repository
   * (add-git-commits D1/D2). The task is accepted only when every repository got its commit.
   */
  async accept(
    workspaceId: string,
    change: string,
    id: string,
    opts: { commit?: { message: string; noVerify?: boolean } } = {},
  ): Promise<ApplyState> {
    const ws = this.workspaces.get(workspaceId);
    const entry = this.#entry(workspaceId, change, id, ["aguardando-revisao"]);
    const tasksFile = this.#tasksFile(ws, change);
    const markdown = readFileSync(tasksFile, "utf8");
    // Find the task again by its id and text: lines may have moved since it ran (D5).
    const task = parseTasks(markdown)
      .sections.flatMap((s) => s.tasks)
      .find((t) => taskId(t) === id);
    if (!task) throw new ApplyStateError(`a task ${id} não está mais no tasks.md`);
    const lines = markdown.split("\n");
    lines[task.line - 1] = lines[task.line - 1]!.replace(/\[[^\]]*\]/, "[x]");
    const marked = lines.join("\n");

    if (opts.commit) {
      const areas = this.#areas(ws);
      const diff = this.#diff(areas, entry, tasksFile, undefined);
      const blocked = this.#commitBlocked(diff, entry, this.repo.list(workspaceId, change));
      if (blocked) throw new ApplyStateError(blocked);
      const groups = this.#commitGroups(areas, diff, entry, tasksFile);
      if (groups.length === 0) throw new ApplyStateError("nenhum dos repositórios desta task está no Git");
      writeFileSync(tasksFile, marked);
      entry.commits = { ...entry.commits };
      try {
        for (const g of groups) {
          if (entry.commits[g.top]) continue; // committed by an earlier attempt that failed later
          entry.commits[g.top] = await commitTree(this.git, g.top, {
            files: g.files,
            fromWorkTree: g.tasks ? [relative(g.top, tasksFile)] : [],
            message: opts.commit.message,
            ...(opts.commit.noVerify ? { noVerify: true } : {}),
          });
          this.repo.save(workspaceId, change, entry);
        }
      } catch (err) {
        writeFileSync(tasksFile, markdown);
        throw err;
      }
    } else {
      writeFileSync(tasksFile, marked);
    }
    entry.status = "aceita";
    this.repo.save(workspaceId, change, entry);
    return this.state(workspaceId, change);
  }

  async adjust(workspaceId: string, change: string, id: string, request: string): Promise<ApplyState> {
    const ws = this.workspaces.get(workspaceId);
    if (this.#queues.has(workspaceId)) throw new ApplyStateError("espere a execução atual terminar para pedir um ajuste");
    const entry = this.#entry(workspaceId, change, id, ["aguardando-revisao", "incompleta"]);
    if (this.repo.list(workspaceId, change).at(-1)?.taskId !== id) {
      throw new ApplyStateError("só a task mais recente pode ser ajustada, porque as seguintes foram feitas sobre ela");
    }
    entry.status = "rodando";
    this.repo.save(workspaceId, change, entry);
    const text = buildTaskAdjustPrompt(id, request, this.#tasksFile(ws, change));
    const queue: Queue = { change, mode: "proxima", stopped: false, done: Promise.resolve() };
    this.#queues.set(workspaceId, queue);
    queue.done = this.runners
      .ready(ws)
      .then((runner) => this.#prompt(ws, change, entry, text, runner))
      .catch(() => {
        // The environment failed: the task goes back to review, as it was before the adjustment.
        entry.status = "aguardando-revisao";
        this.repo.save(workspaceId, change, entry);
      })
      .then(() => undefined)
      .finally(() => this.#queues.delete(workspaceId));
    return this.state(workspaceId, change);
  }

  async undo(workspaceId: string, change: string, id: string): Promise<ApplyState> {
    const ws = this.workspaces.get(workspaceId);
    if (this.#queues.has(workspaceId)) throw new ApplyStateError("espere a execução atual terminar para desfazer");
    const entry = this.#entry(workspaceId, change, id, ["aguardando-revisao", "incompleta"]);
    if (this.repo.list(workspaceId, change).at(-1)?.taskId !== id) {
      throw new ApplyStateError("desfaça primeiro a task mais recente, porque ela foi feita sobre o resultado desta");
    }
    const tasksFile = this.#tasksFile(ws, change);
    for (const area of this.#areas(ws)) {
      const before = entry.before[area.path];
      if (!before) continue;
      const changes = diffSnapshots(area.path, before, snapshot(area.path)).filter(
        (f) => join(area.path, f.path) !== tasksFile,
      );
      restore(area.path, before, changes);
    }
    this.repo.remove(workspaceId, change, id);
    return this.state(workspaceId, change);
  }

  // --- permissions and commands -------------------------------------------

  async reply(workspaceId: string, change: string, requestId: string, choice: ReplyChoice): Promise<ApplyState> {
    const ws = this.workspaces.get(workspaceId);
    const runner = this.runners.current(ws);
    const pending = runner.view(workspaceId, change, "apply")?.permission;
    if (choice === "always" && pending?.requestId === requestId && pending.permission === "bash") {
      for (const command of pending.patterns) this.commands.add(ws, command);
    }
    await runner.answerPermission(
      workspaceId,
      change,
      "apply",
      requestId,
      choice === "reject" ? "reject" : "once",
      choice === "reject" ? "o usuário recusou este comando; siga sem ele" : undefined,
    );
    return this.state(workspaceId, change);
  }

  listCommands(workspaceId: string): string[] {
    return this.commands.get(this.workspaces.get(workspaceId));
  }

  setCommands(workspaceId: string, commands: string[]): string[] {
    this.workspaces.get(workspaceId);
    return this.commands.set(workspaceId, commands);
  }

  // --- internals -----------------------------------------------------------

  #tasksFile(ws: Workspace, change: string): string {
    return join(ws.rootPath, "openspec", "changes", change, "tasks.md");
  }

  #pending(ws: Workspace, change: string) {
    const file = this.#tasksFile(ws, change);
    if (!existsSync(file)) return [];
    const ran = new Set(this.repo.list(ws.id, change).map((e) => e.taskId));
    return parseTasks(readFileSync(file, "utf8")).sections.flatMap((s) =>
      s.tasks.filter((t) => !t.done && !ran.has(taskId(t))).map((t) => ({ id: taskId(t), text: t.text, section: s.title })),
    );
  }

  #entry(workspaceId: string, change: string, id: string, allowed: TaskEntry["status"][]): TaskEntry {
    const entry = this.repo.list(workspaceId, change).find((e) => e.taskId === id);
    if (!entry) throw new ApplyStateError(`a task ${id} não foi executada`);
    if (!allowed.includes(entry.status)) throw new ApplyStateError(`a task ${id} está ${entry.status}`);
    return entry;
  }

  /** The members, plus the root's `openspec/` when the root is not itself a member. */
  #areas(ws: Workspace): Area[] {
    const areas: Area[] = ws.members.map((m: WorkspaceMember) => ({ name: m.name, path: m.path }));
    if (!areas.some((a) => isWithin(a.path, ws.rootPath))) {
      areas.push({ name: "openspec", path: join(ws.rootPath, "openspec") });
    }
    return areas;
  }

  #snapshots(areas: readonly Area[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of areas) if (gitState(a.path).git) out[a.path] = snapshot(a.path);
    return out;
  }

  #diff(areas: readonly Area[], entry: TaskEntry, tasksFile: string, run: RunView | undefined): MemberDiff[] {
    return areas.flatMap((a): MemberDiff[] => {
      const before = entry.before[a.path];
      const after = entry.after?.[a.path];
      if (!before || !after) {
        const written = (run?.files ?? []).filter((f) => isWithin(a.path, f));
        return written.length > 0 ? [{ member: a.name, git: false, files: [], written }] : [];
      }
      const files = diffSnapshots(a.path, before, after).filter((f) => join(a.path, f.path) !== tasksFile);
      if (files.length === 0) return [];
      // A repository this task already committed to (a retry after a partial failure) has the
      // task's content in HEAD: nothing there is "dirty before" any more.
      const committed = entry.commits && Object.keys(entry.commits).length > 0 && entry.commits[repoTop(a.path)];
      const dirty = committed ? [] : dirtyBefore(a.path, before, files);
      return [{ member: a.name, git: true, files, ...(dirty.length > 0 ? { dirtyBefore: dirty } : {}) }];
    });
  }

  /** Why the task cannot be accepted with a commit, if it cannot (spec: change-apply, add-git-commits D3). */
  #commitBlocked(diff: readonly MemberDiff[], entry: TaskEntry, history: readonly TaskEntry[]): string | undefined {
    if (history.some((e) => e.position < entry.position && OPEN.includes(e.status))) {
      return "aceite ou desfaça antes as tasks anteriores: o diff desta foi calculado sobre o resultado delas";
    }
    if (diff.some((d) => d.dirtyBefore?.length)) {
      return "há arquivos que já tinham alterações não commitadas antes da task: o commit levaria também essas alterações";
    }
    return undefined;
  }

  /** The task's files grouped by repository; the repository of tasks.md goes last (D2). */
  #commitGroups(areas: readonly Area[], diff: readonly MemberDiff[], entry: TaskEntry, tasksFile: string): CommitGroup[] {
    const groups = new Map<string, CommitGroup & { names: string[] }>();
    const group = (top: string, name: string) => {
      let g = groups.get(top);
      if (!g) groups.set(top, (g = { top, label: "", names: [], files: [], tasks: false }));
      if (!g.names.includes(name)) g.names.push(name);
      return g;
    };
    for (const d of diff) {
      const area = areas.find((a) => a.name === d.member);
      const tree = area && entry.after?.[area.path];
      if (!area || !d.git || !tree) continue;
      const top = repoTop(area.path);
      const g = group(top, area.name);
      for (const f of d.files) g.files.push({ path: relative(top, join(area.path, f.path)), removed: f.change === "removido", tree });
    }
    const tasksDir = dirname(tasksFile);
    if (gitState(tasksDir).git) {
      const top = repoTop(tasksDir);
      const owner = areas.find((a) => isWithin(a.path, tasksFile))?.name ?? "openspec";
      group(top, owner).tasks = true;
    }
    return [...groups.values()]
      .map(({ names, ...g }) => ({ ...g, label: names.join(", ") }))
      .sort((a, b) => Number(a.tasks) - Number(b.tasks));
  }

  #commitInfo(
    change: string,
    text: string,
    areas: readonly Area[],
    diff: readonly MemberDiff[],
    entry: TaskEntry,
    history: readonly TaskEntry[],
    tasksFile: string,
  ): TaskCommit | undefined {
    const groups = this.#commitGroups(areas, diff, entry, tasksFile);
    if (groups.length === 0) return undefined;
    const reason = this.#commitBlocked(diff, entry, history);
    return {
      allowed: !reason,
      ...(reason ? { reason } : {}),
      message: `${change}: ${entry.taskId} ${text}`,
      repos: groups.map((g) => g.label),
      done: groups.filter((g) => entry.commits?.[g.top]).map((g) => g.label),
    };
  }

  async #contextFiles(ws: Workspace, change: string): Promise<string[]> {
    try {
      const status = await this.openspec.status(target(ws), change);
      return ["proposal", "specs", "design"].flatMap((id) =>
        (status.artifactPaths[id]?.existingOutputPaths ?? []).map((p) => resolve(ws.rootPath, p)),
      );
    } catch {
      return [];
    }
  }
}

function target(ws: Workspace): Target {
  return { cwd: ws.rootPath, store: ws.storeId ?? undefined };
}
