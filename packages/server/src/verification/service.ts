import type { ArchiveGate, RunView, SpecScenario, VerificationItem, VerificationState, Workspace } from "@studio/shared";
import { isConcern, verdictOf } from "@studio/shared";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ApplyRepo } from "../apply/repo.ts";
import type { ExecResult } from "../apply/environments.ts";
import { diffSnapshots, gitState, repoTop, snapshot } from "../apply/snapshot.ts";
import { commitTree, type TreeFile } from "../git/commit.ts";
import { GitClient } from "../git/exec.ts";
import type { OpenSpecAdapter } from "../openspec/adapter.ts";
import { sessionPermissions, WriteGuard } from "../engine/guard.ts";
import type { AgentRunner } from "../engine/runner.ts";
import type { EventBus } from "../events.ts";
import { parseTasks } from "../openspec/tasks.ts";
import { WorkspaceInputError } from "../workspaces/service.ts";
import type { WorkspaceService } from "../workspaces/service.ts";
import { checkEvidence } from "./evidence.ts";
import { beforeTree, prove } from "./proof.ts";
import { changed, fingerprint, REPORT_FILE } from "./fingerprint.ts";
import { buildVerificationPrompt, parseTrace, TraceError, type TraceEntry } from "./prompt.ts";
import { addTestTask, renderReport } from "./report.ts";
import type { VerificationRecord, VerificationRepo } from "./repo.ts";
import { testCommand } from "./runners.ts";
import { changeScenarios } from "./scenarios.ts";

/** An action that does not fit the verification's current state (HTTP 409). */
export class VerificationStateError extends Error {
  override readonly name = "VerificationStateError";
}

/** Where the app runs the tests: the workspace's apply environment (D5). */
export interface TestEnvironment {
  exec(ws: Workspace, argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<ExecResult>;
}

/** Statuses of an apply task whose result is still open. */
const OPEN = ["rodando", "aguardando-permissao", "aguardando-revisao", "incompleta"];
const TEST_TIMEOUT_MS = 5 * 60_000;
const PENDING_ID = "tasks-pendentes";

/** The archive's commit, kept so "Tentar de novo" commits the same files (D10). */
interface ArchiveCommit {
  top: string;
  files: TreeFile[];
}

export interface ArchiveOutcome {
  archivedAs: string;
  specsUpdated: boolean;
  /** The commit made, when the archive was committed. */
  commit?: string;
}

interface Active {
  id: string;
  stopped: boolean;
  /** The agent run's change key while the trace runs, so "Parar" can cancel it. */
  run?: string;
  done: Promise<void>;
}

const key = (workspaceId: string, change: string) => `${workspaceId}\u0000${change}`;

/**
 * Verifies an implemented change (spec: change-verification): the agent points a test to
 * each scenario of the delta specs, the backend checks the evidence and runs the tests, and
 * the report is kept in the database and in the change's verification.md.
 */
export class VerificationService {
  readonly #active = new Map<string, Active>();
  /** Archives whose commit failed, by workspace and change, for "Tentar de novo". */
  readonly #archiveCommits = new Map<string, ArchiveCommit>();
  /** Proofs running, by workspace, change and item. */
  readonly #proofs = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly runner: AgentRunner,
    private readonly environment: TestEnvironment,
    private readonly repo: VerificationRepo,
    private readonly applyRepo: ApplyRepo,
    private readonly events: EventBus,
    private readonly opts: {
      /** Where each verification's work folder (trace.json) goes. */
      workDir: string;
      /** A task of the workspace runs or waits for review. */
      applyBusy?: (workspaceId: string) => boolean;
      testTimeoutMs?: number;
      /**
       * Where the red → green copies go for a workspace: a folder the apply container already
       * mounts, such as its engine folder (D6). Defaults to a folder under `workDir`.
       */
      proofDir?: (workspaceId: string) => string;
      /** Runs `openspec archive`; required for the archive. */
      openspec?: OpenSpecAdapter;
      git?: GitClient;
    },
  ) {}

  start(): void {
    this.repo.interruptRunning();
  }

  /** A verification runs in the workspace: the apply and "Commitar pendências" wait. */
  busy(workspaceId: string): boolean {
    return [...this.#active.keys(), ...this.#proofs.keys()].some((k) => k.startsWith(`${workspaceId}\u0000`));
  }

  /** Waits for the change's verification and proofs to finish (tests and shutdown). */
  async settled(workspaceId: string, change: string): Promise<void> {
    await this.#active.get(key(workspaceId, change))?.done;
    const prefix = `${key(workspaceId, change)}\u0000`;
    await Promise.all([...this.#proofs].filter(([k]) => k.startsWith(prefix)).map(([, p]) => p));
  }

  // --- state -------------------------------------------------------------

  state(workspaceId: string, change: string): VerificationState {
    const ws = this.workspaces.get(workspaceId);
    const dir = this.#changeDir(ws, change);
    if (!existsSync(dir)) throw new WorkspaceInputError(`a change ${change} não existe`);
    const running = this.#active.has(key(workspaceId, change)) ? this.repo.running(workspaceId, change) : undefined;
    const report = this.repo.latest(workspaceId, change);
    const last = this.repo.lastAttempt(workspaceId, change);
    const stale = !!report && changed(report.fingerprint, fingerprint(ws, dir));
    const startReason = this.#startBlocked(ws, change);
    const proofUnavailable = this.#proofUnavailable(ws, change);
    return {
      change,
      ...(running ? { running: strip(running) } : {}),
      ...(report ? { report: strip(report) } : {}),
      ...(last && last.id !== report?.id && last.status !== "rodando" && last.error ? { lastError: last.error } : {}),
      stale,
      canStart: !startReason,
      ...(startReason ? { startReason } : {}),
      ...(proofUnavailable ? { proofUnavailable } : {}),
      archive: this.#gate(ws, report, stale, !!running),
    };
  }

  // --- run ---------------------------------------------------------------

  async run(workspaceId: string, change: string): Promise<VerificationState> {
    const ws = this.workspaces.get(workspaceId);
    const blocked = this.#startBlocked(ws, change);
    if (blocked) throw new VerificationStateError(blocked);
    const dir = this.#changeDir(ws, change);
    const record = this.repo.create(ws.id, change, fingerprint(ws, dir));
    const active: Active = { id: record.id, stopped: false, done: Promise.resolve() };
    this.#active.set(key(ws.id, change), active);
    active.done = this.#verify(ws, change, record, active)
      .catch((err) => this.#end(ws, record, active, "falhou", (err as Error).message))
      .finally(() => {
        this.#active.delete(key(ws.id, change));
        rmSync(this.#workDir(ws, record.id), { recursive: true, force: true });
        this.#publish(ws.id, change);
      });
    this.#publish(ws.id, change);
    return this.state(workspaceId, change);
  }

  async stop(workspaceId: string, change: string): Promise<VerificationState> {
    const active = this.#active.get(key(workspaceId, change));
    if (active) {
      active.stopped = true;
      if (active.run) await this.runner.cancel(workspaceId, active.run).catch(() => undefined);
      const record = this.repo.get(active.id);
      // The test running now finishes on its own (or by its time limit); its result is dropped.
      if (record) this.#end(this.workspaces.get(workspaceId), record, active, "interrompida", "A verificação foi interrompida");
    }
    return this.state(workspaceId, change);
  }

  async #verify(ws: Workspace, change: string, record: VerificationRecord, active: Active): Promise<void> {
    const scenarios = changeScenarios(this.#changeDir(ws, change));
    const items: VerificationItem[] = [];
    if (scenarios.length > 0) {
      const trace = await this.#trace(ws, change, record, active, scenarios);
      if (!trace) return;
      for (const s of scenarios) items.push(this.#item(ws, s, trace.get(s.id)!));
    }
    const pending = this.#pendingTasks(ws, change);
    if (pending.length > 0) items.push({ id: PENDING_ID, kind: "tasks-pendentes", pendingTasks: pending, result: "aguardando" });
    record.items = items;
    this.#save(ws, record, active);
    await this.#runTests(ws, record, active);
    if (active.stopped) return;
    this.#end(ws, record, active, "concluida");
  }

  /** The agent's answer by scenario, or undefined when the verification ended on the way. */
  async #trace(ws: Workspace, change: string, record: VerificationRecord, active: Active, scenarios: SpecScenario[]) {
    const work = this.#workDir(ws, record.id);
    mkdirSync(work, { recursive: true });
    const output = join(work, "trace.json");
    const members = ws.members.map((m) => m.path);
    const prompt = buildVerificationPrompt({ change, changeDir: this.#changeDir(ws, change), members: ws.members, scenarios, outputFile: output });
    active.run = `verificacao-${record.id}`;
    let run: RunView;
    try {
      const handle = await this.runner.start({
        workspaceId: ws.id,
        change: active.run,
        directory: ws.rootPath,
        text: prompt.text,
        system: prompt.system,
        permission: sessionPermissions(ws.rootPath, members, [work], undefined, false),
        guard: new WriteGuard([...new Set([ws.rootPath, ...members])], work),
      });
      if (active.stopped) await this.runner.cancel(ws.id, active.run);
      run = await handle.done;
    } finally {
      delete active.run;
    }
    if (active.stopped) return undefined;
    if (run.status !== "concluido") {
      this.#end(ws, record, active, "falhou", run.error?.message ?? `o rastreio do agente terminou como ${run.status}`);
      return undefined;
    }
    if (!existsSync(output)) {
      this.#end(ws, record, active, "falhou", "o agente terminou sem escrever o trace.json");
      return undefined;
    }
    try {
      return parseTrace(readFileSync(output, "utf8"), scenarios);
    } catch (err) {
      if (!(err instanceof TraceError)) throw err;
      this.#end(ws, record, active, "falhou", err.message);
      return undefined;
    }
  }

  /** A scenario's item from the agent's answer, its evidence checked (D3) and its command built (D4). */
  #item(ws: Workspace, scenario: SpecScenario, entry: TraceEntry): VerificationItem {
    const base: VerificationItem = { id: scenario.id, kind: "cenario", scenario, trace: entry.trace, result: "sem-teste", ...(entry.note ? { note: entry.note } : {}) };
    if (entry.trace === "manual") return { ...base, result: "manual" };
    if (entry.trace === "sem-teste") return base;
    const check = checkEvidence(ws.members, entry.evidence);
    if (!check.ok) return { ...base, ...(entry.evidence ? { evidence: entry.evidence } : {}), result: "evidencia-invalida", reason: check.reason };
    const cmd = testCommand(check.member.path, check.evidence.file, check.evidence.name);
    if (!cmd.argv) return { ...base, evidence: check.evidence, result: "nao-executado", ...(cmd.reason ? { reason: cmd.reason } : {}) };
    return { ...base, evidence: check.evidence, result: "aguardando", command: cmd.argv };
  }

  /** Runs each (member, command) once, one at a time, reusing the result for every item that shares it. */
  async #runTests(ws: Workspace, record: VerificationRecord, active: Active): Promise<void> {
    const done = new Map<string, ExecResult>();
    for (const item of record.items) {
      if (item.result !== "aguardando" || !item.command || !item.evidence) continue;
      if (active.stopped) return;
      const member = ws.members.find((m) => m.name === item.evidence!.member)!;
      const runKey = JSON.stringify([member.path, item.command]);
      let res = done.get(runKey);
      if (!res) {
        item.result = "rodando";
        this.#save(ws, record, active);
        res = await this.environment.exec(ws, item.command, { cwd: member.path, timeoutMs: this.opts.testTimeoutMs ?? TEST_TIMEOUT_MS });
        done.set(runKey, res);
        if (active.stopped) return;
      }
      item.result = res.exitCode === 0 && !res.timedOut ? "coberto" : "falhou";
      item.output = res.output;
      if (res.timedOut) item.reason = "o teste passou do tempo limite";
      this.#save(ws, record, active);
    }
  }

  // --- items -------------------------------------------------------------

  /** Marks a manual item as checked (spec: "Veredito da verificação"). */
  check(workspaceId: string, change: string, itemId: string, note?: string): VerificationState {
    return this.#update(workspaceId, change, itemId, (item) => {
      if (item.result !== "manual") throw new VerificationStateError("só um item de verificação manual pode ser marcado como conferido");
      item.checked = note?.trim() ? { note: note.trim() } : {};
    });
  }

  uncheck(workspaceId: string, change: string, itemId: string): VerificationState {
    return this.#update(workspaceId, change, itemId, (item) => {
      delete item.checked;
    });
  }

  /** Justifies an item that keeps the verdict at CONCERNS; an empty text removes the justification. */
  justify(workspaceId: string, change: string, itemId: string, text: string): VerificationState {
    return this.#update(workspaceId, change, itemId, (item) => {
      if (!isConcern(item)) throw new VerificationStateError("só um item que deixa o veredito em CONCERNS precisa de justificativa");
      if (text.trim()) item.justification = text.trim();
      else delete item.justification;
    });
  }

  /** Adds a test task for a scenario without a valid test to tasks.md (D8). */
  addTestTask(workspaceId: string, change: string, itemId: string): { state: VerificationState; taskId: string } {
    const ws = this.workspaces.get(workspaceId);
    const report = this.#report(ws, change);
    const item = report.items.find((i) => i.id === itemId);
    if (!item?.scenario) throw new WorkspaceInputError(`item desconhecido: ${itemId}`);
    if (item.result !== "sem-teste" && item.result !== "evidencia-invalida") {
      throw new VerificationStateError("a task de teste só é oferecida para um cenário sem teste ou com evidência inválida");
    }
    const file = join(this.#changeDir(ws, change), "tasks.md");
    const { markdown, id } = addTestTask(readFileSync(file, "utf8"), item.scenario);
    writeFileSync(file, markdown);
    this.#publish(ws.id, change);
    return { state: this.state(workspaceId, change), taskId: id };
  }

  /**
   * Starts the red → green proof of a covered item (D6). It runs in the background; the item
   * shows "rodando" until it ends, and the result goes to the report.
   */
  async prove(workspaceId: string, change: string, itemId: string): Promise<VerificationState> {
    const ws = this.workspaces.get(workspaceId);
    const report = this.#report(ws, change);
    const item = report.items.find((i) => i.id === itemId);
    if (!item) throw new WorkspaceInputError(`item desconhecido: ${itemId}`);
    if (item.result !== "coberto" || !item.command || !item.evidence) {
      throw new VerificationStateError("a prova só é oferecida para um item coberto por um teste que passou");
    }
    const proofKey = `${key(ws.id, change)}\u0000${itemId}`;
    if (this.#proofs.has(proofKey)) throw new VerificationStateError("a prova deste item já está rodando");
    if (changed(report.fingerprint, fingerprint(ws, this.#changeDir(ws, change)))) {
      throw new VerificationStateError("o código ou os artefatos mudaram depois da verificação: verifique de novo antes de provar");
    }
    const member = ws.members.find((m) => m.name === item.evidence!.member)!;
    const before = beforeTree(this.applyRepo.list(ws.id, change), member.path);
    if (!before) throw new VerificationStateError(this.#proofUnavailable(ws, change) ?? `não há retrato de ${member.name} de antes da change`);
    item.proof = { status: "rodando" };
    this.repo.save(report);
    this.#publish(ws.id, change);
    const workDir = join(this.opts.proofDir?.(ws.id) ?? join(this.opts.workDir, ws.id, "provas"), `${report.id}-${crypto.randomUUID().slice(0, 8)}`);
    const argv = item.command;
    const done = prove({ ws, member: member.path, before, argv, workDir, environment: this.environment, timeoutMs: this.opts.testTimeoutMs ?? TEST_TIMEOUT_MS })
      .then((proof) => {
        // The report may have changed meanwhile (a justification): update the stored one.
        const current = this.repo.get(report.id);
        const target = current?.items.find((i) => i.id === itemId);
        if (!current || !target) return;
        target.proof = proof;
        this.repo.save(current);
        this.#writeReport(ws, current);
      })
      .finally(() => {
        this.#proofs.delete(proofKey);
        this.#publish(ws.id, change);
      });
    this.#proofs.set(proofKey, done);
    return this.state(workspaceId, change);
  }

  // --- archive -------------------------------------------------------------

  /**
   * Archives the change behind the gate (D10): `openspec archive` applies the delta specs and
   * moves the change, then the change's apply and verification records are dropped. With
   * `commit`, the files the archive moved or changed are committed, and nothing else.
   */
  async archive(workspaceId: string, change: string, opts: { commit?: { message: string; noVerify?: boolean } } = {}): Promise<ArchiveOutcome> {
    const ws = this.workspaces.get(workspaceId);
    const gate = this.state(workspaceId, change).archive;
    if (!gate.allowed) throw new VerificationStateError(gate.reason ?? "a change não pode ser arquivada agora");
    if (!this.opts.openspec) throw new Error("o archive não está disponível");
    if (opts.commit && !gate.git) throw new VerificationStateError("a raiz OpenSpec não está num repositório Git");
    const area = join(ws.rootPath, "openspec");
    const before = gate.git ? snapshot(area) : undefined;
    const result = await this.opts.openspec.archive({ cwd: ws.rootPath, store: ws.storeId ?? undefined }, change);
    this.applyRepo.removeChange(ws.id, change);
    this.repo.removeChange(ws.id, change);
    this.#publish(ws.id, change);
    const outcome: ArchiveOutcome = { archivedAs: result.archivedAs, specsUpdated: result.specsUpdated };
    if (!opts.commit || !before) return outcome;
    const after = snapshot(area);
    const top = repoTop(area);
    const files = diffSnapshots(area, before, after).map((f): TreeFile => ({
      path: relative(top, join(area, f.path)),
      ...(f.change === "removido" ? { removed: true } : {}),
      tree: after,
    }));
    this.#archiveCommits.set(key(ws.id, change), { top, files });
    return { ...outcome, commit: await this.commitArchive(workspaceId, change, opts.commit) };
  }

  /** Commits an archive whose commit failed, with the same files ("Tentar de novo"). */
  async commitArchive(workspaceId: string, change: string, commit: { message: string; noVerify?: boolean }): Promise<string> {
    const pending = this.#archiveCommits.get(key(workspaceId, change));
    if (!pending) throw new VerificationStateError(`não há commit de archive pendente para ${change}`);
    const sha = await commitTree(this.opts.git ?? new GitClient(), pending.top, {
      files: pending.files,
      message: commit.message,
      ...(commit.noVerify ? { noVerify: true } : {}),
    });
    this.#archiveCommits.delete(key(workspaceId, change));
    this.events.publish({ type: "git-changed", workspaceId });
    return sha;
  }

  // --- internals -----------------------------------------------------------

  /** Why the proof is not offered for any item of the change, when it is not. */
  #proofUnavailable(ws: Workspace, change: string): string | undefined {
    const entries = this.applyRepo.list(ws.id, change);
    if (ws.members.some((m) => beforeTree(entries, m.path))) return undefined;
    return "as tasks desta change não foram executadas pela app, então não há retrato de antes da change";
  }

  #update(workspaceId: string, change: string, itemId: string, fn: (item: VerificationItem) => void): VerificationState {
    const ws = this.workspaces.get(workspaceId);
    const report = this.#report(ws, change);
    const item = report.items.find((i) => i.id === itemId);
    if (!item) throw new WorkspaceInputError(`item desconhecido: ${itemId}`);
    fn(item);
    this.repo.save(report);
    this.#writeReport(ws, report);
    this.#publish(ws.id, change);
    return this.state(workspaceId, change);
  }

  #report(ws: Workspace, change: string): VerificationRecord {
    if (this.#active.has(key(ws.id, change))) throw new VerificationStateError("espere a verificação terminar");
    const report = this.repo.latest(ws.id, change);
    if (!report) throw new VerificationStateError("a change ainda não foi verificada");
    return report;
  }

  #startBlocked(ws: Workspace, change: string): string | undefined {
    if (this.#active.has(key(ws.id, change))) return "a verificação desta change já está rodando";
    if ([...this.#proofs.keys()].some((k) => k.startsWith(`${key(ws.id, change)}\u0000`))) return "espere a prova em andamento terminar";
    if (!existsSync(join(this.#changeDir(ws, change), "tasks.md"))) return "a change ainda não tem tasks.md";
    const open = this.applyRepo.list(ws.id, change).filter((e) => OPEN.includes(e.status));
    if (open.length > 0) return `aceite ou desfaça antes as tasks em aberto (${open.map((e) => e.taskId).join(", ")})`;
    if (this.opts.applyBusy?.(ws.id)) return "há um apply rodando ou aguardando revisão neste workspace";
    return undefined;
  }

  /** The archive gate (spec: "Arquivar a change pela app", D10). */
  #gate(ws: Workspace, report: VerificationRecord | undefined, stale: boolean, running: boolean): ArchiveGate {
    const git = gitState(join(ws.rootPath, "openspec")).git;
    const missing = (report?.items ?? []).filter((i) => isConcern(i) && !i.justification).map((i) => i.id);
    const reason = running
      ? "espere a verificação terminar"
      : !report
        ? "verifique a change antes de arquivar"
        : stale
          ? "o código ou os artefatos mudaram depois da verificação: verifique de novo"
          : verdictOf(report.items) === "FAIL"
            ? "há testes falhando: corrija e verifique de novo"
            : missing.length > 0
              ? `justifique os itens que deixam o veredito em CONCERNS (${missing.length})`
              : undefined;
    return { allowed: !reason, ...(reason ? { reason } : {}), missing, git };
  }

  #pendingTasks(ws: Workspace, change: string): string[] {
    const file = join(this.#changeDir(ws, change), "tasks.md");
    if (!existsSync(file)) return [];
    return parseTasks(readFileSync(file, "utf8"))
      .sections.flatMap((s) => s.tasks)
      .filter((t) => !t.done)
      .map((t) => t.id ?? `linha ${t.line}`);
  }

  #save(ws: Workspace, record: VerificationRecord, active: Active): void {
    if (active.stopped && record.status === "rodando") return;
    this.repo.save(record);
    this.#publish(ws.id, record.change);
  }

  #end(ws: Workspace, record: VerificationRecord, active: Active, status: "concluida" | "falhou" | "interrompida", error?: string): void {
    // Already ended elsewhere ("Parar" saves its own copy of the record).
    if (record.status !== "rodando" || this.repo.get(record.id)?.status !== "rodando") return;
    if (status !== "concluida") active.stopped = true;
    record.status = status;
    record.finishedAt = new Date().toISOString();
    if (error) record.error = error;
    this.repo.save(record);
    this.repo.prune(ws.id, record.change);
    if (status === "concluida") this.#writeReport(ws, record);
    this.#publish(ws.id, record.change);
  }

  #writeReport(ws: Workspace, record: VerificationRecord): void {
    writeFileSync(join(this.#changeDir(ws, record.change), REPORT_FILE), renderReport(ws, record));
  }

  #changeDir(ws: Workspace, change: string): string {
    return join(ws.rootPath, "openspec", "changes", change);
  }

  #workDir(ws: Workspace, id: string): string {
    return join(this.opts.workDir, ws.id, id);
  }

  #publish(workspaceId: string, change: string): void {
    this.events.publish({ type: "verification-changed", workspaceId, change });
  }
}

/** The report without the stored fingerprint. */
function strip({ fingerprint: _f, workspaceId: _w, ...report }: VerificationRecord) {
  return report;
}
