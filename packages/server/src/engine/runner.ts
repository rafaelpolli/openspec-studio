import type { AgentEvent, PermissionReply, RunError, RunErrorKind, RunView, SessionKind } from "@studio/shared";
import { isAbsolute, relative } from "node:path";
import type { EventBus } from "../events.ts";
import type { Engine, PermissionRule } from "./engine.ts";
import type { WriteGuard } from "./guard.ts";
import type { ChangeSessions } from "./sessions.ts";

export class RunConflictError extends Error {
  override readonly name = "RunConflictError";
}

export interface RunRequest {
  workspaceId: string;
  change: string;
  /** Directory the session works in (the OpenSpec root). */
  directory: string;
  text: string;
  system?: string;
  /** Session permissions used when the change gets a new session. */
  permission?: PermissionRule[];
  /** Detects (and where possible reverts) writes outside the OpenSpec root. */
  guard?: WriteGuard;
  /** Which of the change's sessions runs the prompt; planning by default. */
  kind?: SessionKind;
  /** Folders whose written files the run lists; the session directory by default. */
  fileRoots?: string[];
}

export interface RunHandle {
  run: RunView;
  /** True when this run could not reuse the change's previous session history. */
  historyLost: boolean;
  done: Promise<RunView>;
}

interface Active {
  key: string;
  workspaceId: string;
  change: string;
  kind: SessionKind;
  directory: string;
  fileRoots: string[];
  view: RunView;
  cancelRequested: boolean;
  guard: WriteGuard | undefined;
  finish: (view: RunView) => void;
}

const key = (workspaceId: string, change: string, kind: SessionKind = "plan") =>
  `${workspaceId}\u0000${change}\u0000${kind}`;

/** Maps OpenCode error names to what the user is told. */
export function classifyError(name: string, message: string): RunError {
  const kind: RunErrorKind =
    name === "ProviderAuthError"
      ? "autenticacao"
      : /rate|quota|429|limit/i.test(`${name} ${message}`)
        ? "limite"
        : /ECONNREFUSED|ECONNRESET|fetch failed|network|socket|connection/i.test(message)
          ? "conexao"
          : "outro";
  const prefix: Record<RunErrorKind, string> = {
    autenticacao: "Falha de autenticação no provedor de LLM",
    limite: "Limite de uso do provedor atingido",
    conexao: "Sem conexão com o motor ou o provedor",
    interrompido: "O motor foi interrompido",
    outro: "O agente falhou",
  };
  return { kind, message: `${prefix[kind]}: ${message}` };
}

function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Runs one prompt at a time per change on the change's session, streams progress to the
 * UI, and settles as concluido, cancelado or falhou (spec: agent-sessions).
 */
export class AgentRunner {
  readonly #active = new Map<string, Active>();
  readonly #bySession = new Map<string, Active>();
  readonly #last = new Map<string, RunView>();

  constructor(
    private readonly engine: Engine,
    private readonly sessions: ChangeSessions,
    private readonly events: EventBus,
  ) {
    engine.onEvent((event) => {
      if (event.kind === "interrupted") {
        for (const run of [...this.#active.values()]) {
          this.#settle(run, "falhou", { kind: "interrompido", message: "O motor foi interrompido e reiniciado" });
        }
      } else if (event.kind !== "state") {
        this.#onAgentEvent(event);
      }
    });
  }

  /** Number of runs in progress across all changes. */
  get activeCount(): number {
    return this.#active.size;
  }

  /** The running or most recent run of a change. */
  view(workspaceId: string, change: string, kind: SessionKind = "plan"): RunView | undefined {
    const k = key(workspaceId, change, kind);
    return this.#active.get(k)?.view ?? this.#last.get(k);
  }

  async start(req: RunRequest): Promise<RunHandle> {
    const kind = req.kind ?? "plan";
    const k = key(req.workspaceId, req.change, kind);
    if (this.#active.has(k)) throw new RunConflictError(`the agent is already working on ${req.change}`);
    const session = await this.sessions.forChange(req.workspaceId, req.change, req.directory, req.permission, kind);

    let finish!: (view: RunView) => void;
    const done = new Promise<RunView>((resolve) => (finish = resolve));
    const run: Active = {
      key: k,
      workspaceId: req.workspaceId,
      change: req.change,
      kind,
      directory: req.directory,
      fileRoots: req.fileRoots ?? [req.directory],
      cancelRequested: false,
      guard: req.guard,
      finish,
      view: {
        runId: crypto.randomUUID(),
        sessionId: session.sessionId,
        status: "rodando",
        startedAt: new Date().toISOString(),
        transcript: [],
        tools: [],
        files: [],
      },
    };
    this.#active.set(k, run);
    this.#bySession.set(session.sessionId, run);
    run.guard?.begin();
    this.#publish(run);

    try {
      await this.engine.prompt(session.sessionId, req.text, {
        directory: req.directory,
        ...(req.system ? { system: req.system } : {}),
      });
    } catch (err) {
      this.#settle(run, "falhou", classifyError("PromptError", (err as Error).message));
    }
    return { run: run.view, historyLost: !session.historyAvailable, done };
  }

  /** Stops the change's running prompt (spec: agent-sessions, "Cancelar execução do agente"). */
  async cancel(workspaceId: string, change: string, kind: SessionKind = "plan"): Promise<RunView | undefined> {
    const run = this.#active.get(key(workspaceId, change, kind));
    if (!run) return this.view(workspaceId, change, kind);
    run.cancelRequested = true;
    const pending = run.view.permission;
    if (pending) {
      // A pending request is rejected, or the engine keeps the tool call waiting (spec: change-apply).
      await this.engine.replyPermission(pending.requestId, run.directory, "reject", "a etapa foi interrompida").catch(() => {});
    }
    try {
      await this.engine.abort(run.view.sessionId, run.directory);
    } finally {
      // Settle now: the engine may or may not send a final event for an aborted prompt.
      this.#settle(run, "cancelado");
    }
    return run.view;
  }

  /** Answers the run's pending permission request (add-visual-apply D3). */
  async answerPermission(
    workspaceId: string,
    change: string,
    kind: SessionKind,
    requestId: string,
    reply: PermissionReply,
    message?: string,
  ): Promise<void> {
    const run = this.#active.get(key(workspaceId, change, kind));
    if (!run || run.view.permission?.requestId !== requestId) {
      throw new RunConflictError("não há um pedido de permissão pendente com esse id");
    }
    await this.engine.replyPermission(requestId, run.directory, reply, message);
    delete run.view.permission;
    this.#publish(run);
  }

  #onAgentEvent(event: AgentEvent): void {
    if (event.kind === "file") {
      for (const run of this.#active.values()) {
        if (run.fileRoots.some((r) => isWithin(r, event.path)) && !run.view.files.includes(event.path)) {
          run.view.files.push(event.path);
          this.#publish(run);
        }
      }
      return;
    }
    if (event.kind === "error" && !event.sessionId) return;
    const run = this.#bySession.get(event.sessionId!);
    if (!run) return;
    switch (event.kind) {
      case "text": {
        const part = run.view.transcript.find((p) => p.partId === event.partId);
        if (part) part.text += event.delta;
        else run.view.transcript.push({ partId: event.partId, text: event.delta });
        this.#publish(run);
        return;
      }
      case "tool": {
        const tool = run.view.tools.find((t) => t.callId === event.callId);
        const entry = { callId: event.callId, tool: event.tool, status: event.status, ...(event.title ? { title: event.title } : {}) };
        if (tool) Object.assign(tool, entry);
        else run.view.tools.push(entry);
        this.#publish(run);
        return;
      }
      case "question":
        run.view.questions = [...(run.view.questions ?? []), ...event.questions];
        this.#publish(run);
        return;
      case "permission":
        run.view.permission = event.request;
        this.#publish(run);
        return;
      case "idle":
        this.#settle(run, run.cancelRequested ? "cancelado" : "concluido");
        return;
      case "error":
        if (run.cancelRequested || event.name === "MessageAbortedError") this.#settle(run, "cancelado");
        else this.#settle(run, "falhou", classifyError(event.name, event.message));
        return;
    }
  }

  #settle(run: Active, status: RunView["status"], error?: RunError): void {
    if (run.view.status !== "rodando") return;
    run.view.status = status;
    delete run.view.permission;
    if (error) run.view.error = error;
    const violations = run.guard?.finish();
    if (violations && violations.length > 0) run.view.violations = violations;
    this.#active.delete(run.key);
    this.#bySession.delete(run.view.sessionId);
    this.#last.set(run.key, run.view);
    this.#publish(run);
    run.finish(run.view);
  }

  #publish(run: Active): void {
    this.events.publish({
      type: "run-updated",
      workspaceId: run.workspaceId,
      change: run.change,
      ...(run.kind === "apply" ? { kind: "apply" as const } : {}),
      run: run.view,
    });
  }
}
