import { ChangeDraft, type Exploration, type ExplorationSummary, type RunView, type Workspace } from "@studio/shared";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionPermissions, WriteGuard } from "../engine/guard.ts";
import type { AgentRunner } from "../engine/runner.ts";
import type { EventBus } from "../events.ts";
import { suggestChangeName, type ProposalService } from "../proposal/service.ts";
import { WorkspaceNotFoundError, type WorkspaceService } from "../workspaces/service.ts";
import { buildDraftPrompt, buildFirstPrompt, buildNextPrompt, previousContext, type WorkspaceContext } from "./prompt.ts";
import type { ExplorationRecord, ExplorationRepo } from "./repo.ts";

/** An action that does not fit the exploration's state (HTTP 409). */
export class ExplorationStateError extends Error {
  override readonly name = "ExplorationStateError";
}

/** The file in the change folder with the conversation it came from (D4). */
export const EXPLORATION_MD = "exploration.md";
const TITLE_FILE = "titulo.txt";
const DRAFT_FILE = "rascunho.json";
const MAX_TITLE = 80;

/** The run key of an exploration's session in the AgentRunner (D1). */
export const sessionKey = (id: string) => `explorar-${id}`;

const answerText = (run: RunView) => (run.transcript ?? []).map((p) => p.text).join("").trim();

/**
 * Conversations with the agent before a change exists (spec: workspace-exploration): one
 * read-only engine session per exploration, the messages kept in the database, and "Virar
 * change" creating the change with the decisions of the conversation already answered.
 */
export class ExplorationService {
  /** Explorations whose agent is answering or writing the draft. */
  readonly #busy = new Map<string, Promise<unknown>>();
  /** Why the last draft request failed, by exploration. */
  readonly #draftErrors = new Map<string, string>();

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly runner: AgentRunner,
    private readonly repo: ExplorationRepo,
    private readonly events: EventBus,
    private readonly opts: {
      /** Where each exploration's work folder (title, draft) goes. */
      workDir: string;
      /** The workspace's specs and active changes, given to the agent at the start. */
      context: (ws: Workspace) => Promise<WorkspaceContext>;
      /** Creates the change on "Virar change". */
      proposals?: ProposalService;
    },
  ) {}

  start(): void {
    this.repo.interruptRunning();
  }

  list(workspaceId: string): ExplorationSummary[] {
    this.workspaces.get(workspaceId);
    return this.repo.list(workspaceId).map(summary);
  }

  get(workspaceId: string, id: string): Exploration {
    const e = this.#record(workspaceId, id);
    return {
      ...summary(e),
      messages: this.repo.messages(id),
      ...(e.draft ? { draft: e.draft } : {}),
      busy: this.#busy.has(id),
      ...(this.#draftErrors.has(id) ? { draftError: this.#draftErrors.get(id)! } : {}),
    };
  }

  /** A new active exploration; `from` continues another one that is closed (D6). */
  create(workspaceId: string, from?: string): Exploration {
    this.workspaces.get(workspaceId);
    if (from) {
      const parent = this.#record(workspaceId, from);
      if (parent.status === "ativa") throw new ExplorationStateError("só dá para continuar a partir de uma exploração encerrada");
    }
    const e = this.repo.create(workspaceId, from);
    this.#publish(workspaceId, e.id);
    return this.get(workspaceId, e.id);
  }

  /** Waits for the exploration's agent to finish (tests and shutdown). */
  async settled(id: string): Promise<void> {
    await this.#busy.get(id);
  }

  // --- conversation ----------------------------------------------------------

  async send(workspaceId: string, id: string, text: string): Promise<Exploration> {
    const ws = this.workspaces.get(workspaceId);
    const e = this.#active(workspaceId, id);
    const first = !this.repo.messages(id).some((m) => m.role === "agente");
    const work = this.#workDir(ws, id);
    const prompt = first
      ? buildFirstPrompt({
          message: text,
          members: ws.members,
          context: await this.opts.context(ws),
          titleFile: join(work, TITLE_FILE),
          ...this.#previous(workspaceId, e),
        })
      : buildNextPrompt(text);
    this.repo.addMessage(id, "usuario", text, "concluida");
    const answer = this.repo.addMessage(id, "agente", "", "respondendo");
    this.#run(ws, id, prompt, async (run) => {
      const partial = answerText(run);
      if (run.status === "concluido") this.repo.updateMessage(answer, partial, "concluida");
      else if (run.status === "cancelado") this.repo.updateMessage(answer, partial, "interrompida");
      else this.repo.updateMessage(answer, [partial, `Erro: ${run.error?.message ?? run.status}`].filter(Boolean).join("\n\n"), "falhou");
      const title = join(work, TITLE_FILE);
      if (first && existsSync(title)) {
        const line = readFileSync(title, "utf8").trim().split("\n")[0]?.trim().slice(0, MAX_TITLE);
        if (line) this.repo.setTitle(id, line, false);
      }
      rmSync(title, { force: true });
    });
    return this.get(workspaceId, id);
  }

  async stop(workspaceId: string, id: string): Promise<Exploration> {
    this.#record(workspaceId, id);
    if (this.#busy.has(id)) await this.runner.cancel(workspaceId, sessionKey(id)).catch(() => undefined);
    await this.#busy.get(id);
    return this.get(workspaceId, id);
  }

  rename(workspaceId: string, id: string, title: string): Exploration {
    this.#record(workspaceId, id);
    this.repo.setTitle(id, title.trim().slice(0, MAX_TITLE), true);
    this.#publish(workspaceId, id);
    return this.get(workspaceId, id);
  }

  // --- "Virar change" -----------------------------------------------------------

  /** Asks the agent for the change draft (D4); the result comes as the exploration's `draft`. */
  async draft(workspaceId: string, id: string): Promise<Exploration> {
    const ws = this.workspaces.get(workspaceId);
    this.#active(workspaceId, id);
    if (!this.repo.messages(id).some((m) => m.role === "agente" && m.status === "concluida")) {
      throw new ExplorationStateError("converse com o agente antes de virar change");
    }
    const file = join(this.#workDir(ws, id), DRAFT_FILE);
    rmSync(file, { force: true });
    this.#draftErrors.delete(id);
    this.#run(ws, id, buildDraftPrompt(file), async (run) => {
      try {
        if (run.status !== "concluido") throw new ExplorationStateError(run.error?.message ?? "o agente não escreveu o rascunho");
        this.repo.setDraft(id, parseDraft(existsSync(file) ? readFileSync(file, "utf8") : undefined));
      } catch (err) {
        this.#draftErrors.set(id, (err as Error).message);
      } finally {
        rmSync(file, { force: true });
      }
    });
    return this.get(workspaceId, id);
  }

  /**
   * Creates the change from the draft the user reviewed (D4, D5): the decisions come answered
   * into its checkpoint, the conversation goes to exploration.md, the exploration closes.
   */
  async toChange(workspaceId: string, id: string, draft: ChangeDraft): Promise<Exploration> {
    const ws = this.workspaces.get(workspaceId);
    const e = this.#active(workspaceId, id);
    if (!this.opts.proposals) throw new Error("a criação de changes não está disponível");
    this.repo.setDraft(id, draft);
    await this.opts.proposals.create(workspaceId, draft.name, draft.description, { decisions: draft.decisions });
    const changeDir = join(ws.rootPath, "openspec", "changes", draft.name);
    writeFileSync(join(changeDir, EXPLORATION_MD), renderExploration(e, this.repo.messages(id), draft));
    const decided = draft.decisions.map((d) => `- ${d.question}: ${d.answer}`).join("\n");
    this.repo.setStatus(id, "virou-change", { change: draft.name, summary: [draft.description, decided].filter(Boolean).join("\n\n") });
    this.#publish(workspaceId, id);
    return this.get(workspaceId, id);
  }

  discard(workspaceId: string, id: string): Exploration {
    this.#active(workspaceId, id);
    this.repo.setStatus(id, "descartada");
    this.#publish(workspaceId, id);
    return this.get(workspaceId, id);
  }

  // --- internals -------------------------------------------------------------

  /** Runs one prompt on the exploration's session; `finish` records the outcome. */
  #run(ws: Workspace, id: string, prompt: { text: string; system: string }, finish: (run: RunView) => Promise<void>): void {
    const work = this.#workDir(ws, id);
    mkdirSync(work, { recursive: true });
    const members = ws.members.map((m) => m.path);
    const done = (async () => {
      let run: RunView;
      try {
        const handle = await this.runner.start({
          workspaceId: ws.id,
          change: sessionKey(id),
          directory: ws.rootPath,
          text: prompt.text,
          system: prompt.system,
          permission: sessionPermissions(ws.rootPath, members, [work], undefined, false),
          guard: new WriteGuard([...new Set([ws.rootPath, ...members])], work),
        });
        run = await handle.done;
      } catch (err) {
        run = { status: "falhou", transcript: [], error: { kind: "outro", message: (err as Error).message } } as unknown as RunView;
      }
      await finish(run);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.#busy.delete(id);
        this.#publish(ws.id, id);
      });
    this.#busy.set(id, done);
    this.#publish(ws.id, id);
  }

  #previous(workspaceId: string, e: ExplorationRecord): { previous?: string } {
    if (!e.parentId) return {};
    const parent = this.repo.get(e.parentId);
    if (!parent || parent.workspaceId !== workspaceId) return {};
    return {
      previous: previousContext({
        title: parent.title,
        ...(parent.change ? { change: parent.change } : {}),
        ...(parent.summary ? { summary: parent.summary } : {}),
        messages: this.repo.messages(parent.id).filter((m) => m.text),
      }),
    };
  }

  #record(workspaceId: string, id: string): ExplorationRecord {
    const e = this.repo.get(id);
    if (!e || e.workspaceId !== workspaceId) throw new WorkspaceNotFoundError(`exploração não encontrada: ${id}`);
    return e;
  }

  /** An active exploration whose agent is not busy. */
  #active(workspaceId: string, id: string): ExplorationRecord {
    const e = this.#record(workspaceId, id);
    if (e.status !== "ativa") throw new ExplorationStateError(`a exploração está ${e.status === "virou-change" ? "encerrada (virou change)" : "descartada"}`);
    if (this.#busy.has(id)) throw new ExplorationStateError("espere o agente terminar a resposta");
    return e;
  }

  #workDir(ws: Workspace, id: string): string {
    return join(this.opts.workDir, ws.id, id);
  }

  #publish(workspaceId: string, explorationId: string): void {
    this.events.publish({ type: "exploration-changed", workspaceId, explorationId });
  }
}

function summary(e: ExplorationRecord): ExplorationSummary {
  const { titleByUser: _t, summary: _s, draft: _d, ...rest } = e;
  return rest;
}

/** The draft the agent wrote (D4); an invalid name is replaced by one from the description. */
export function parseDraft(raw: string | undefined): ChangeDraft {
  if (raw === undefined) throw new ExplorationStateError("o agente terminou sem escrever o rascunho da change");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ExplorationStateError("o agente escreveu um rascunho que não é JSON");
  }
  const loose = json as { name?: unknown; description?: unknown };
  const named = { ...(json as object), name: typeof loose.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(loose.name) ? loose.name : suggestChangeName(String(loose.description ?? "")) };
  const checked = ChangeDraft.safeParse(named);
  if (!checked.success) throw new ExplorationStateError("o rascunho do agente não segue o formato pedido");
  return checked.data;
}

/** exploration.md: where the change came from and the whole conversation (D4). */
export function renderExploration(e: ExplorationRecord, messages: readonly { role: string; text: string; status: string }[], draft: ChangeDraft): string {
  const lines = [`# Exploração: ${e.title ?? draft.name}`, "", `- Origem da change \`${draft.name}\`, criada em ${new Date().toISOString().slice(0, 10)}.`, ""];
  if (draft.decisions.length > 0) {
    lines.push("## Decisões", "", ...draft.decisions.map((d) => `- **${d.question}:** ${d.answer}`), "");
  }
  lines.push("## Conversa", "");
  for (const m of messages) {
    if (!m.text) continue;
    const who = m.role === "usuario" ? "Usuário" : "Agente";
    const note = m.status === "interrompida" ? " (interrompida)" : m.status === "falhou" ? " (falhou)" : "";
    lines.push(`### ${who}${note}`, "", m.text.trim(), "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
