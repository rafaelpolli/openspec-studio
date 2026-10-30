import type { Database } from "bun:sqlite";
import { answerText, type ArtifactStatus, type DecisionAnswer, type DecisionCheckpoint, type ProposalView, type RunView, type Workspace } from "@studio/shared";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sessionPermissions, WriteGuard } from "../engine/guard.ts";
import type { AgentRunner } from "../engine/runner.ts";
import type { OpenSpecAdapter, Target } from "../openspec/adapter.ts";
import { CliError } from "../openspec/cli.ts";
import { resolveInside } from "../workspaces/paths.ts";
import { WorkspaceInputError, type WorkspaceService } from "../workspaces/service.ts";
import { DECISIONS_MD, renderDecisions } from "./decisions-md.ts";
import { answersHash, DecisionsRepo } from "./decisions-repo.ts";
import { AgentOutputError, assumptionsFile, DECISIONS_FILE, parseAssumptions, parseDecisions, WORK_DIR } from "./decisions.ts";
import { buildAdjustPrompt, buildArtifactPrompt, buildDecisionsPrompt, buildFixPrompt, type BuiltPrompt, type DecisionContext } from "./prompt.ts";
import { DECISIONS_DEP, issuesByArtifact, isDeltaSpecArtifact, proposalStates, type Approval } from "./states.ts";

/** Checkpoint states that keep the first artifact waiting (add-proposal-decisions D4). */
const PENDING: readonly DecisionCheckpoint["status"][] = ["levantando", "aguardando", "falhou"];

/** An action that does not fit the artifact's current state (HTTP 409). */
export class ProposalStateError extends Error {
  override readonly name = "ProposalStateError";
}

const STOPWORDS = new Set(
  "a o os as de do da dos das e em no na nos nas um uma para por com que ao the of and to in for on with".split(" "),
);

/** Suggests a kebab-case change name from a free-text description (spec: "Iniciar uma change"). */
export function suggestChangeName(description: string): string {
  const words = description
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w));
  return words.slice(0, 5).join("-") || "nova-change";
}

interface ArtifactFiles {
  /** Absolute paths that exist on disk. */
  files: string[];
  hash: string | undefined;
}

/**
 * The guided proposal (spec: guided-proposal): artifacts are generated one at a time by
 * the agent, validated, and approved by the user before their dependents can be generated.
 */
export class ProposalService {
  readonly #auto = new Set<string>();
  readonly #generating = new Map<string, string>();
  readonly #notice = new Map<string, string>();
  /** Checkpoints being raised by the agent. */
  readonly #raising = new Map<string, Promise<void>>();
  readonly #decisions: DecisionsRepo;

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly openspec: OpenSpecAdapter,
    private readonly runner: AgentRunner,
    private readonly db: Database,
  ) {
    this.#decisions = new DecisionsRepo(db);
  }

  start(): void {
    this.#decisions.interruptRunning();
  }

  // --- 7.1 ---------------------------------------------------------------

  /**
   * `opts.decisions` are decisions already taken in an exploration (add-workspace-explore D5):
   * they come answered into the checkpoint, and the agent only raises the ones still open.
   */
  async create(
    workspaceId: string,
    name: string,
    description: string,
    opts: { decisions?: readonly { question: string; answer: string }[] } = {},
  ): Promise<ProposalView> {
    const ws = this.workspaces.get(workspaceId);
    const existing = await this.openspec.listChanges(target(ws)).catch(() => []);
    if (existing.some((c) => c.name === name)) {
      throw new ProposalStateError(`já existe uma change ativa chamada ${name}; escolha outro nome ou abra a existente`);
    }
    try {
      await this.openspec.newChange(target(ws), name);
    } catch (err) {
      if (err instanceof CliError && /already exists/i.test(err.message)) {
        throw new ProposalStateError(`já existe uma change chamada ${name}`);
      }
      throw err;
    }
    this.db
      .query("INSERT OR REPLACE INTO change_meta (workspace_id, change_name, description, created_at) VALUES (?, ?, ?, ?)")
      .run(workspaceId, name, description, new Date().toISOString());
    // The checkpoint starts at once, so the change opens with its decisions being raised (D1).
    const explored = fromExploration(opts.decisions ?? []);
    this.#decisions.save(workspaceId, name, { status: "levantando", ...explored, resumeAuto: false });
    this.#raise(ws, name);
    return this.view(workspaceId, name);
  }

  // --- view ----------------------------------------------------------------

  async view(workspaceId: string, change: string): Promise<ProposalView> {
    const ws = this.workspaces.get(workspaceId);
    const status = await this.openspec.status(target(ws), change);
    const files = this.#files(ws, status.artifacts, status.artifactPaths);
    const hashes = Object.fromEntries(
      Object.entries(files).flatMap(([id, f]) => (f.hash ? [[id, f.hash] as const] : [])),
    );
    const specWritten = status.artifacts.some((a) => isDeltaSpecArtifact(a.outputPath) && hashes[a.id]);
    const report = specWritten ? await this.openspec.validate(target(ws), change) : undefined;
    const issues = issuesByArtifact(status.artifacts, report?.items.find((i) => i.id === change)?.issues ?? []);
    const k = key(workspaceId, change);
    const checkpoint = this.#decisions.get(workspaceId, change);
    return {
      change,
      description: this.#description(workspaceId, change),
      artifacts: proposalStates({
        artifacts: status.artifacts,
        hashes,
        approvals: this.#approvals(workspaceId, change),
        generating: this.#generating.get(k) ?? null,
        issues,
        decisionsPending: !!checkpoint && PENDING.includes(checkpoint.status),
        answersHash: answersHash(checkpoint),
        generations: this.#decisions.generations(workspaceId, change),
      }),
      autoRunning: this.#auto.has(k),
      generating: this.#generating.get(k) ?? null,
      notice: this.#notice.get(k) ?? null,
      decisions: checkpoint,
    };
  }

  // --- 7.3 ---------------------------------------------------------------

  /**
   * Generates one artifact. Outside "gerar o resto", its dependencies must be approved;
   * in auto mode they only need to be written (approval comes at the end).
   */
  async generate(
    workspaceId: string,
    change: string,
    artifactId: string,
    opts: { auto?: boolean; view?: ProposalView } = {},
  ) {
    const ws = this.workspaces.get(workspaceId);
    // Each view costs two CLI calls (~2 s); callers that just computed one pass it in.
    const view = opts.view ?? (await this.view(workspaceId, change));
    const artifact = view.artifacts.find((a) => a.id === artifactId);
    if (!artifact) throw new WorkspaceInputError(`artefato desconhecido: ${artifactId}`);
    if (artifact.waitingOn.includes(DECISIONS_DEP)) {
      throw new ProposalStateError(`responda ou pule as decisões antes de gerar ${artifactId}`);
    }
    const written = new Set(["aguardando_aprovacao", "aprovado", "a_revisar", "ignorado"]);
    const depsOk = opts.auto
      ? artifact.requires.every((d) => written.has(view.artifacts.find((a) => a.id === d)?.state ?? ""))
      : artifact.state === "pronto";
    if (!depsOk) {
      throw new ProposalStateError(
        artifact.state === "bloqueado"
          ? `${artifactId} depende de: ${artifact.waitingOn.join(", ")}`
          : `${artifactId} não pode ser gerado agora (estado: ${artifact.state})`,
      );
    }
    const instr = await this.openspec.instructions(target(ws), change, artifactId);
    if (instr.skipped) throw new ProposalStateError(`${artifactId} é ignorado nesta change`);
    const decisions = this.#decisionContext(ws, change, artifactId);
    const prompt = buildArtifactPrompt(instr, {
      description: this.#description(workspaceId, change) ?? change,
      members: ws.members,
      ...decisions,
    });
    return this.#run(ws, change, artifactId, prompt, decisions.assumptionsFile);
  }

  /** Asks the agent to fix this artifact's validation issues, in the change's session. */
  async fix(workspaceId: string, change: string, artifactId: string) {
    const ws = this.workspaces.get(workspaceId);
    const artifact = await this.#artifact(workspaceId, change, artifactId);
    if (artifact.issues.length === 0) throw new ProposalStateError(`${artifactId} não tem problemas de validação`);
    const files = await this.#existing(ws, change, artifactId);
    return this.#run(ws, change, artifactId, buildFixPrompt(artifactId, files, artifact.issues));
  }

  // --- 7.4 ---------------------------------------------------------------

  async approve(workspaceId: string, change: string, artifactId: string): Promise<ProposalView> {
    const ws = this.workspaces.get(workspaceId);
    const status = await this.openspec.status(target(ws), change);
    const files = this.#files(ws, status.artifacts, status.artifactPaths);
    const artifact = (await this.view(workspaceId, change)).artifacts.find((a) => a.id === artifactId);
    if (!artifact || !["aguardando_aprovacao", "a_revisar"].includes(artifact.state)) {
      throw new ProposalStateError(`${artifactId} não está aguardando aprovação (estado: ${artifact?.state ?? "?"})`);
    }
    const deps = Object.fromEntries(artifact.requires.map((d) => [d, files[d]?.hash ?? ""]));
    this.db
      .query(
        `INSERT INTO artifact_approvals (workspace_id, change_name, artifact_id, content_hash, approved_at, deps_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, change_name, artifact_id)
         DO UPDATE SET content_hash = excluded.content_hash, approved_at = excluded.approved_at, deps_json = excluded.deps_json`,
      )
      .run(workspaceId, change, artifactId, files[artifactId]!.hash!, new Date().toISOString(), JSON.stringify(deps));
    return this.#withRecord(ws, await this.view(workspaceId, change));
  }

  // --- 7.5 ---------------------------------------------------------------

  /** Saves the user's edit to one of the artifact's files. */
  async saveEdit(workspaceId: string, change: string, artifactId: string, path: string, content: string) {
    const ws = this.workspaces.get(workspaceId);
    const status = await this.openspec.status(target(ws), change);
    const allowed = (status.artifactPaths[artifactId]?.existingOutputPaths ?? []).map((f) =>
      relative(status.changeRoot, f),
    );
    if (!allowed.includes(path)) throw new WorkspaceInputError(`${path} não é um arquivo do artefato ${artifactId}`);
    writeFileSync(resolveInside([ws.rootPath], join(status.changeRoot, path)), content);
    return this.view(workspaceId, change);
  }

  async adjust(workspaceId: string, change: string, artifactId: string, request: string) {
    const ws = this.workspaces.get(workspaceId);
    const files = await this.#existing(ws, change, artifactId);
    if (files.length === 0) throw new ProposalStateError(`${artifactId} ainda não foi escrito`);
    const decisions = this.#decisionContext(ws, change, artifactId);
    return this.#run(ws, change, artifactId, buildAdjustPrompt(artifactId, files, request, decisions), decisions.assumptionsFile);
  }

  // --- 7.6 ---------------------------------------------------------------

  /**
   * Generates every remaining artifact in dependency order without pausing for approval,
   * stopping at the first generation or validation error. Returns at once; progress is
   * reported through run events and the proposal view.
   */
  async generateRest(workspaceId: string, change: string): Promise<ProposalView> {
    const k = key(workspaceId, change);
    if (this.#auto.has(k)) throw new ProposalStateError("a geração automática já está em andamento");
    const checkpoint = this.#decisions.get(workspaceId, change);
    if (checkpoint && PENDING.includes(checkpoint.status)) {
      // Stops once at the checkpoint and continues by itself after the answers (D7).
      this.#decisions.save(workspaceId, change, { ...checkpoint, resumeAuto: true });
      this.#notice.set(k, "A geração continua depois que você responder às decisões.");
      return this.view(workspaceId, change);
    }
    this.#auto.add(k);
    this.#notice.delete(k);
    void this.#autoLoop(workspaceId, change).finally(() => this.#auto.delete(k));
    return this.view(workspaceId, change);
  }

  /** Waits for "gerar o resto" to finish (tests and shutdown). */
  async settled(workspaceId: string, change: string): Promise<void> {
    const k = key(workspaceId, change);
    while (this.#auto.has(k) || this.#generating.has(k) || this.#raising.has(k)) {
      await Bun.sleep(20);
    }
  }

  async #autoLoop(workspaceId: string, change: string): Promise<void> {
    const k = key(workspaceId, change);
    try {
      let view = await this.view(workspaceId, change);
      while (true) {
        const written = new Set(["aguardando_aprovacao", "aprovado", "a_revisar", "ignorado"]);
        const next = view.artifacts.find(
          (a) =>
            (a.state === "pronto" || a.state === "bloqueado") &&
            a.requires.every((d) => written.has(view.artifacts.find((x) => x.id === d)?.state ?? "")),
        );
        if (!next) return;
        const handle = await this.generate(workspaceId, change, next.id, { auto: true, view });
        const run = await handle.done;
        if (run.status !== "concluido") {
          this.#notice.set(k, `Geração automática interrompida em ${next.id}: ${run.error?.message ?? run.status}`);
          return;
        }
        await this.#idle(k);
        view = await this.view(workspaceId, change);
        const after = view.artifacts.find((a) => a.id === next.id);
        if (after?.state !== "aguardando_aprovacao") {
          this.#notice.set(k, `Geração automática interrompida: ${next.id} não foi escrito`);
          return;
        }
        if (after.issues.length > 0) {
          this.#notice.set(k, `Geração automática interrompida: ${next.id} tem erros de validação`);
          return;
        }
      }
    } catch (err) {
      this.#notice.set(k, `Geração automática interrompida: ${(err as Error).message}`);
    }
  }

  // --- internals -------------------------------------------------------------

  /** Waits until the post-run bookkeeping of the last generation has finished. */
  async #idle(k: string): Promise<void> {
    while (this.#generating.has(k)) await Bun.sleep(10);
  }

  async #run(ws: Workspace, change: string, artifactId: string, prompt: BuiltPrompt, assumptions?: string) {
    const k = key(ws.id, change);
    if (this.#generating.has(k)) throw new ProposalStateError(`o agente já está gerando ${this.#generating.get(k)}`);
    if (this.#raising.has(k)) throw new ProposalStateError("o agente ainda está levantando as decisões");
    if (assumptions) this.#resetWorkDir(ws, change);
    const memberPaths = ws.members.map((m) => m.path);
    this.#generating.set(k, artifactId);
    this.#notice.delete(k);
    try {
      const handle = await this.runner.start({
        workspaceId: ws.id,
        change,
        directory: ws.rootPath,
        text: prompt.text,
        system: prompt.system,
        permission: sessionPermissions(ws.rootPath, memberPaths),
        guard: new WriteGuard(memberPaths, join(ws.rootPath, "openspec")),
      });
      void handle.done.then(async (run) => {
        // Clear "generating" only after the check, so whoever waits sees its notice.
        await this.#checkWritten(ws, change, artifactId, run)
          .then(() => (assumptions ? this.#recordGeneration(ws, change, artifactId, run, assumptions) : undefined))
          .finally(() => this.#generating.delete(k));
      });
      if (handle.historyLost) {
        this.#notice.set(k, "O histórico da sessão anterior não está disponível; o agente começou uma sessão nova.");
      }
      return handle;
    } catch (err) {
      this.#generating.delete(k);
      throw err;
    }
  }

  /** Flags a run that finished without writing the artifact (it stays as it was). */
  async #checkWritten(ws: Workspace, change: string, artifactId: string, run: RunView): Promise<void> {
    if (run.status !== "concluido") return;
    const files = await this.#existing(ws, change, artifactId).catch(() => []);
    if (files.length === 0) this.#notice.set(key(ws.id, change), `O agente terminou sem escrever ${artifactId}.`);
  }

  // --- decisions checkpoint (add-proposal-decisions) -------------------------

  /** Saves the answers, one per decision; also edits them later (D4: the generated artifacts go "a revisar"). */
  async answer(workspaceId: string, change: string, answers: readonly DecisionAnswer[]): Promise<ProposalView> {
    const ws = this.workspaces.get(workspaceId);
    const checkpoint = this.#decisions.get(workspaceId, change);
    if (!checkpoint || !["aguardando", "respondido"].includes(checkpoint.status)) {
      throw new ProposalStateError("as decisões desta change não estão aguardando respostas");
    }
    const byId = new Map(answers.map((a) => [a.id, a]));
    const unknown = answers.find((a) => !checkpoint.decisions.some((d) => d.id === a.id));
    if (unknown) throw new WorkspaceInputError(`decisão desconhecida: ${unknown.id}`);
    const missing = checkpoint.decisions.filter((d) => !byId.has(d.id)).map((d) => d.id);
    if (missing.length > 0) throw new WorkspaceInputError(`responda todas as decisões (faltam: ${missing.join(", ")})`);
    for (const d of checkpoint.decisions) {
      const a = byId.get(d.id)!;
      if (a.kind === "opcao" && a.option >= d.options.length) throw new WorkspaceInputError(`opção inválida para ${d.id}`);
    }
    const ordered = checkpoint.decisions.map((d) => byId.get(d.id)!);
    this.#decisions.save(workspaceId, change, { ...checkpoint, status: "respondido", answers: ordered, resumeAuto: false });
    return this.#afterCheckpoint(ws, change, checkpoint.resumeAuto);
  }

  /** Skips the checkpoint; a checkpoint still being raised is cancelled. */
  async skip(workspaceId: string, change: string): Promise<ProposalView> {
    const ws = this.workspaces.get(workspaceId);
    const checkpoint = this.#decisions.get(workspaceId, change);
    if (!checkpoint || !PENDING.includes(checkpoint.status)) throw new ProposalStateError("não há decisões a pular nesta change");
    this.#decisions.save(workspaceId, change, { ...checkpoint, status: "pulado", answers: [], resumeAuto: false });
    if (checkpoint.status === "levantando") await this.runner.cancel(workspaceId, change).catch(() => undefined);
    await this.#raising.get(key(workspaceId, change));
    return this.#afterCheckpoint(ws, change, checkpoint.resumeAuto);
  }

  /** Raises the decisions again after a failure. */
  async retryDecisions(workspaceId: string, change: string): Promise<ProposalView> {
    const ws = this.workspaces.get(workspaceId);
    const checkpoint = this.#decisions.get(workspaceId, change);
    if (checkpoint?.status !== "falhou") throw new ProposalStateError("só um levantamento de decisões que falhou pode ser repetido");
    // The decisions from the exploration stay; only the agent's are raised again.
    const taken = checkpoint.decisions.filter((d) => d.source === "exploracao");
    const answers = checkpoint.answers.filter((a) => taken.some((d) => d.id === a.id));
    this.#decisions.save(workspaceId, change, { status: "levantando", decisions: taken, answers, resumeAuto: checkpoint.resumeAuto });
    this.#raise(ws, change);
    return this.view(workspaceId, change);
  }

  async #afterCheckpoint(ws: Workspace, change: string, resume: boolean): Promise<ProposalView> {
    const view = this.#withRecord(ws, await this.view(ws.id, change));
    return resume ? this.generateRest(ws.id, change) : view;
  }

  /** Runs the checkpoint prompt on the change's planning session and records the outcome (D1, D2). */
  #raise(ws: Workspace, change: string): void {
    const k = key(ws.id, change);
    const output = join(this.#resetWorkDir(ws, change), DECISIONS_FILE);
    const memberPaths = ws.members.map((m) => m.path);
    const explored = (this.#decisions.get(ws.id, change)?.decisions ?? []).filter((d) => d.source === "exploracao");
    const prompt = buildDecisionsPrompt({
      change,
      description: this.#description(ws.id, change) ?? change,
      members: ws.members,
      outputFile: output,
      taken: explored.map((d) => ({ question: d.question, answer: d.options[0]?.label ?? "" })),
    });
    const done = (async () => {
      let run: RunView;
      try {
        const handle = await this.runner.start({
          workspaceId: ws.id,
          change,
          directory: ws.rootPath,
          text: prompt.text,
          system: prompt.system,
          permission: sessionPermissions(ws.rootPath, memberPaths),
          guard: new WriteGuard(memberPaths, join(ws.rootPath, "openspec")),
        });
        run = await handle.done;
      } catch (err) {
        run = { status: "falhou", error: { kind: "outro", message: (err as Error).message } } as RunView;
      }
      const raw = existsSync(output) ? readFileSync(output, "utf8") : undefined;
      this.#removeWorkDir(ws, change);
      const checkpoint = this.#decisions.get(ws.id, change);
      if (checkpoint?.status !== "levantando") return; // skipped meanwhile
      let next: DecisionCheckpoint;
      if (run.status !== "concluido") {
        next = { ...checkpoint, status: "falhou", error: run.error?.message ?? `o levantamento terminou como ${run.status}` };
      } else {
        try {
          const raised = parseDecisions(raw).filter((d) => !d.id.startsWith(EXPLORED_PREFIX));
          const taken = checkpoint.decisions.filter((d) => d.source === "exploracao");
          const answers = checkpoint.answers.filter((a) => taken.some((d) => d.id === a.id));
          // Nothing left to decide counts as answered: the proposal can be generated (spec: "Nenhuma decisão").
          next = { status: raised.length > 0 ? "aguardando" : "respondido", decisions: [...taken, ...raised], answers, resumeAuto: checkpoint.resumeAuto };
        } catch (err) {
          if (!(err instanceof AgentOutputError)) throw err;
          next = { ...checkpoint, status: "falhou", error: err.message };
        }
      }
      this.#decisions.save(ws.id, change, { ...next, resumeAuto: next.status === "respondido" ? false : next.resumeAuto });
      if (next.status === "respondido") await this.#afterCheckpoint(ws, change, next.resumeAuto);
    })()
      .catch((err) => {
        this.#decisions.save(ws.id, change, { status: "falhou", decisions: [], answers: [], resumeAuto: false, error: (err as Error).message });
      })
      .finally(() => this.#raising.delete(k));
    this.#raising.set(k, done);
  }

  /** The answered decisions and the assumptions file for an artifact's prompt (D5). */
  #decisionContext(ws: Workspace, change: string, artifactId: string): DecisionContext & { assumptionsFile: string } {
    const checkpoint = this.#decisions.get(ws.id, change);
    const decisions =
      checkpoint?.status === "respondido"
        ? checkpoint.decisions.flatMap((d) => {
            const answer = answerText(d, checkpoint.answers.find((a) => a.id === d.id));
            return answer ? [{ question: d.question, answer }] : [];
          })
        : [];
    return {
      ...(decisions.length > 0 ? { decisions } : {}),
      assumptionsFile: join(this.#changeDir(ws, change), WORK_DIR, assumptionsFile(artifactId)),
    };
  }

  /**
   * Keeps what a generation or adjustment assumed, with the answers it was written with (D3, D5):
   * the agent's list plus every question it asked that nobody could answer.
   */
  #recordGeneration(ws: Workspace, change: string, artifactId: string, run: RunView, file: string): void {
    if (run.status === "concluido") {
      const listed = parseAssumptions(existsSync(file) ? readFileSync(file, "utf8") : undefined);
      const asked = (run.questions ?? [])
        .filter((q) => !listed.some((a) => a.question === q))
        .map((q) => ({ text: "o agente seguiu sem resposta e registrou a escolha no artefato", question: q }));
      this.#decisions.saveGeneration(ws.id, change, artifactId, {
        assumptions: [...listed, ...asked],
        decisionsHash: answersHash(this.#decisions.get(ws.id, change)),
      });
    }
    this.#removeWorkDir(ws, change);
  }

  /** Rewrites decisions.md from the database (D6); a change without a checkpoint has none. */
  #withRecord(ws: Workspace, view: ProposalView): ProposalView {
    if (view.decisions) {
      writeFileSync(join(this.#changeDir(ws, view.change), DECISIONS_MD), renderDecisions(view.change, view.decisions, view.artifacts));
    }
    return view;
  }

  #changeDir(ws: Workspace, change: string): string {
    return join(ws.rootPath, "openspec", "changes", change);
  }

  #resetWorkDir(ws: Workspace, change: string): string {
    const dir = join(this.#changeDir(ws, change), WORK_DIR);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  #removeWorkDir(ws: Workspace, change: string): void {
    rmSync(join(this.#changeDir(ws, change), WORK_DIR), { recursive: true, force: true });
  }

  async #artifact(workspaceId: string, change: string, artifactId: string) {
    const artifact = (await this.view(workspaceId, change)).artifacts.find((a) => a.id === artifactId);
    if (!artifact) throw new WorkspaceInputError(`artefato desconhecido: ${artifactId}`);
    return artifact;
  }

  async #existing(ws: Workspace, change: string, artifactId: string): Promise<string[]> {
    const status = await this.openspec.status(target(ws), change);
    return status.artifactPaths[artifactId]?.existingOutputPaths ?? [];
  }

  #files(
    ws: Workspace,
    artifacts: readonly ArtifactStatus[],
    paths: Record<string, { existingOutputPaths: string[] }>,
  ): Record<string, ArtifactFiles> {
    return Object.fromEntries(
      artifacts.map((a) => {
        const files = (paths[a.id]?.existingOutputPaths ?? []).slice().sort();
        if (files.length === 0) return [a.id, { files, hash: undefined }];
        const hash = createHash("sha256");
        for (const f of files) {
          hash.update(f).update("\0").update(readFileSync(resolveInside([ws.rootPath], f))).update("\0");
        }
        return [a.id, { files, hash: hash.digest("hex") }];
      }),
    );
  }

  #approvals(workspaceId: string, change: string): Record<string, Approval> {
    const rows = this.db
      .query<{ artifact_id: string; content_hash: string; deps_json: string }, [string, string]>(
        "SELECT artifact_id, content_hash, deps_json FROM artifact_approvals WHERE workspace_id = ? AND change_name = ?",
      )
      .all(workspaceId, change);
    return Object.fromEntries(rows.map((r) => [r.artifact_id, { contentHash: r.content_hash, deps: JSON.parse(r.deps_json) }]));
  }

  #description(workspaceId: string, change: string): string | null {
    return (
      this.db
        .query<{ description: string }, [string, string]>(
          "SELECT description FROM change_meta WHERE workspace_id = ? AND change_name = ?",
        )
        .get(workspaceId, change)?.description ?? null
    );
  }
}

const EXPLORED_PREFIX = "exploracao-";

/** Decisions taken in an exploration, as answered single-option checkpoint decisions (D5). */
function fromExploration(taken: readonly { question: string; answer: string }[]): Pick<DecisionCheckpoint, "decisions" | "answers"> {
  const decisions = taken.map((t, i) => ({
    id: `${EXPLORED_PREFIX}${i + 1}`,
    question: t.question,
    options: [{ label: t.answer }],
    recommended: 0,
    source: "exploracao" as const,
  }));
  return { decisions, answers: decisions.map((d) => ({ id: d.id, kind: "recomendada" as const })) };
}

function target(ws: Workspace): Target {
  return { cwd: ws.rootPath, store: ws.storeId ?? undefined };
}

function key(workspaceId: string, change: string): string {
  return `${workspaceId}\u0000${change}`;
}
