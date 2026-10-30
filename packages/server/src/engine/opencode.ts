import { createOpencodeClient, type GlobalEvent, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { EngineProcessState, PermissionReply } from "@studio/shared";
import type { Engine, EngineEvent, PermissionRule, PromptOptions } from "./engine.ts";
import { bundledBinary, engineEnv, spawnServer, stopServer, type RunningServer } from "./process.ts";
import { BUILTIN_PROVIDER } from "./status.ts";

export interface OpencodeEngineOptions {
  /** Folder that holds all engine state (isolated XDG dirs). */
  dataDir: string;
  /** OpenCode config injected at every start (model, permissions). */
  config?: () => Record<string, unknown>;
  binary?: { path: string; version: string };
  /** Environment the allowlist is applied to; defaults to process.env. */
  sourceEnv?: Record<string, string | undefined>;
  startTimeoutMs?: number;
  /**
   * Sessions whose permission requests go to the user (apply, add-visual-apply D3); every
   * other request is rejected on the spot.
   */
  interactive?: (sessionId: string) => boolean;
  maxRestarts?: number;
  /**
   * Starts the engine somewhere else than a child process of the backend, such as inside a
   * workspace's container (add-apply-devcontainer D4). Gets the engine environment.
   */
  launcher?: EngineLauncher;
}

export interface EngineLauncher {
  /** Prepares the place the engine runs in and returns the command that runs it in the foreground. */
  prepare(env: Record<string, string>): Promise<{ command: string[]; rewriteUrl: (url: string) => string }>;
  /** Stops the engine where it runs; ending the foreground command alone may not. */
  stop?(): Promise<void>;
}

/** Settings that keep the embedded engine from reaching out on its own. */
const BASE_CONFIG = { autoupdate: false, share: "disabled" };

/** The answer given to every question the agent asks (task 6.9). */
export const UNANSWERED =
  "O usuário não pode responder agora. Siga com a opção mais razoável e inclua a pergunta e a sua escolha na lista de suposições pedida.";

function randomPassword(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

type Payload = GlobalEvent["payload"];

/** Maps an OpenCode event to the app's normalized agent event, if relevant. */
export function toAgentEvent(directory: string, payload: Payload): EngineEvent | undefined {
  const p = payload as { type: string; properties: Record<string, unknown> };
  const props = p.properties;
  switch (p.type) {
    case "message.part.delta":
      if (props.field !== "text") return undefined;
      return {
        kind: "text",
        sessionId: String(props.sessionID),
        partId: String(props.partID),
        delta: String(props.delta),
      };
    case "message.part.updated": {
      const part = props.part as { type: string; sessionID: string; callID?: string; tool?: string; state?: { status?: string; title?: string } };
      if (part.type !== "tool") return undefined;
      return {
        kind: "tool",
        sessionId: part.sessionID,
        callId: part.callID ?? "",
        tool: part.tool ?? "",
        status: part.state?.status ?? "",
        ...(part.state?.title ? { title: part.state.title } : {}),
      };
    }
    case "file.edited":
      return { kind: "file", directory, path: String(props.file) };
    case "session.idle":
      return { kind: "idle", sessionId: String(props.sessionID) };
    case "session.error": {
      const error = props.error as { name?: string; data?: { message?: string } } | undefined;
      return {
        kind: "error",
        ...(props.sessionID ? { sessionId: String(props.sessionID) } : {}),
        name: error?.name ?? "UnknownError",
        message: error?.data?.message ?? "the engine reported an error",
      };
    }
    default:
      return undefined;
  }
}

/** The embedded OpenCode engine: owns the `opencode serve` child and its client (design D4). */
export class OpencodeEngine implements Engine {
  readonly version: string;
  #state: EngineProcessState = "stopped";
  #lastError: string | undefined;
  #server: RunningServer | undefined;
  #client: OpencodeClient | undefined;
  #password = "";
  #starting: Promise<void> | undefined;
  #generation = 0;
  #restarts = 0;
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  readonly #binary: { path: string; version: string };

  constructor(private readonly opts: OpencodeEngineOptions) {
    this.#binary = opts.binary ?? bundledBinary();
    this.version = this.#binary.version;
  }

  get state(): EngineProcessState {
    return this.#state;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  /** Base URL and Basic credentials of the running engine (for direct HTTP calls such as auth). */
  get connection(): { url: string; authorization: string } | undefined {
    if (!this.#server) return undefined;
    return { url: this.#server.url, authorization: this.#authorization() };
  }

  get pid(): number | undefined {
    return this.#server?.proc.pid;
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async ensureRunning(): Promise<void> {
    if (this.#state === "running") return;
    this.#starting ??= this.#start().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async restart(): Promise<void> {
    await this.#shutdown();
    this.#restarts = 0;
    await this.ensureRunning();
  }

  async stop(): Promise<void> {
    await this.#shutdown();
    this.#setState("stopped");
  }

  async createSession(opts: { directory: string; title?: string; permission?: PermissionRule[] }): Promise<string> {
    const client = await this.#ready();
    const res = await client.session.create(
      {
        directory: opts.directory,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.permission ? { permission: opts.permission } : {}),
      },
      { throwOnError: true },
    );
    return res.data.id;
  }

  async sessionExists(sessionId: string, directory: string): Promise<boolean> {
    const client = await this.#ready();
    const res = await client.session.get({ sessionID: sessionId, directory });
    return res.error === undefined && res.data !== undefined;
  }

  async prompt(sessionId: string, text: string, opts: PromptOptions): Promise<void> {
    const client = await this.#ready();
    const model = opts.model ?? (await this.#promptModel(client));
    await client.session.promptAsync(
      {
        sessionID: sessionId,
        directory: opts.directory,
        parts: [{ type: "text", text }],
        ...(opts.system ? { system: opts.system } : {}),
        ...(model ? { model } : {}),
      },
      { throwOnError: true },
    );
  }

  /**
   * The model sent with every prompt. Without it OpenCode reuses the model of the session's
   * previous message (stale after the default changes) or picks one itself, which can be a
   * deprecated model it then refuses ("Model not found").
   */
  async #promptModel(client: OpencodeClient): Promise<{ providerID: string; modelID: string } | undefined> {
    const configured = this.opts.config?.().model;
    if (typeof configured === "string" && configured.includes("/")) {
      const [providerID, ...rest] = configured.split("/");
      return { providerID: providerID!, modelID: rest.join("/") };
    }
    const list = await client.provider.list({}, { throwOnError: true });
    for (const providerID of list.data.connected) {
      if (providerID === BUILTIN_PROVIDER) continue;
      const provider = list.data.all.find((p) => p.id === providerID);
      if (!provider) continue;
      const preferred = list.data.default[providerID];
      const modelID = preferred && provider.models[preferred] ? preferred : Object.keys(provider.models).sort()[0];
      if (modelID) return { providerID, modelID };
    }
    return undefined;
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    const client = await this.#ready();
    await client.session.abort({ sessionID: sessionId, directory }, { throwOnError: true });
  }

  // --- provider administration (OpenCode-specific; see ProviderService) ---

  async providerCatalog() {
    const client = await this.#ready();
    const [list, auth] = await Promise.all([
      client.provider.list({}, { throwOnError: true }),
      client.provider.auth({}, { throwOnError: true }),
    ]);
    return { all: list.data.all, connected: list.data.connected, methods: auth.data };
  }

  async setApiKey(providerID: string, key: string): Promise<void> {
    const client = await this.#ready();
    await client.auth.set({ providerID, auth: { type: "api", key } }, { throwOnError: true });
  }

  async removeAuth(providerID: string): Promise<void> {
    const client = await this.#ready();
    await client.auth.remove({ providerID }, { throwOnError: true });
  }

  async oauthAuthorize(providerID: string, method: number, inputs?: Record<string, string>) {
    const client = await this.#ready();
    const res = await client.provider.oauth.authorize(
      { providerID, method, ...(inputs ? { inputs } : {}) },
      { throwOnError: true },
    );
    return res.data;
  }

  async oauthCallback(providerID: string, method: number, code?: string): Promise<boolean> {
    const client = await this.#ready();
    const res = await client.provider.oauth.callback(
      { providerID, method, ...(code ? { code } : {}) },
      { throwOnError: true },
    );
    return res.data;
  }

  async connectedProviders(): Promise<string[]> {
    const client = await this.#ready();
    const res = await client.provider.list({}, { throwOnError: true });
    return res.data.connected;
  }

  async #ready(): Promise<OpencodeClient> {
    await this.ensureRunning();
    if (!this.#client) throw new Error("engine is not running");
    return this.#client;
  }

  #authorization(): string {
    return `Basic ${Buffer.from(`opencode:${this.#password}`).toString("base64")}`;
  }

  async #start(): Promise<void> {
    this.#setState(this.#restarts > 0 ? "restarting" : "starting");
    this.#password = randomPassword();
    const env = engineEnv({
      dataDir: this.opts.dataDir,
      password: this.#password,
      config: { ...BASE_CONFIG, ...this.opts.config?.() },
      ...(this.opts.sourceEnv ? { source: this.opts.sourceEnv } : {}),
    });
    try {
      const launched = await this.opts.launcher?.prepare(env);
      const server = await spawnServer({
        binary: this.#binary.path,
        env,
        cwd: this.opts.dataDir,
        ...(launched ? { command: launched.command, rewriteUrl: launched.rewriteUrl } : {}),
        ...(this.opts.startTimeoutMs ? { timeoutMs: this.opts.startTimeoutMs } : {}),
      });
      this.#server = server;
      this.#client = createOpencodeClient({
        baseUrl: server.url,
        headers: { authorization: this.#authorization() },
      });
      const generation = ++this.#generation;
      void server.proc.exited.then(() => this.#onExit(generation));
      void this.#pump(generation);
      this.#lastError = undefined;
      this.#setState("running");
      // A process that stays up for a minute resets the crash budget.
      setTimeout(() => {
        if (generation === this.#generation) this.#restarts = 0;
      }, 60_000).unref();
    } catch (err) {
      this.#server = undefined;
      this.#client = undefined;
      this.#lastError = (err as Error).message;
      this.#setState("failed", this.#lastError);
      throw err;
    }
  }

  /** Forwards engine events until this generation of the process goes away. */
  async #pump(generation: number): Promise<void> {
    while (generation === this.#generation && this.#client) {
      try {
        const { stream } = await this.#client.global.event();
        for await (const event of stream as AsyncIterable<GlobalEvent>) {
          if (generation !== this.#generation) return;
          if (event.payload.type === "permission.asked") this.#onPermission(event.directory, event.payload.properties);
          if (event.payload.type === "question.asked") this.#answer(event.directory, event.payload.properties);
          const mapped = toAgentEvent(event.directory, event.payload);
          if (mapped) this.#emit(mapped);
        }
      } catch {
        // Stream dropped; retry while this process is still current.
      }
      await Bun.sleep(250);
    }
  }

  #onPermission(directory: string, request: { id: string; sessionID: string; permission: string; patterns: string[] }): void {
    if (!this.opts.interactive?.(request.sessionID)) return this.#reject(directory, request.id);
    this.#emit({
      kind: "permission",
      sessionId: request.sessionID,
      directory,
      request: { requestId: request.id, permission: request.permission, patterns: request.patterns },
    });
  }

  async replyPermission(requestId: string, directory: string, reply: PermissionReply, message?: string): Promise<void> {
    const client = await this.#ready();
    await client.permission.reply(
      { requestID: requestId, directory, reply, ...(reply === "reject" && message ? { message } : {}) },
      { throwOnError: true },
    );
  }

  /**
   * Outside apply sessions nobody answers permission prompts, so a pending `ask` would stall the session
   * until it is cancelled. Rejecting it hands the agent an error it can work around (D8).
   */
  #reject(directory: string, requestID: string): void {
    this.#client?.permission
      .reply({ requestID, directory, reply: "reject", message: "fora das pastas liberadas para esta sessão" })
      .catch(() => {});
  }

  /**
   * The app has no way to show the agent's questions, so a pending one would stall the
   * session. Each is answered with a note telling the agent to carry on without the user
   * (task 6.9); the questions themselves are reported to the run's stream.
   */
  #answer(directory: string, request: { id: string; sessionID: string; questions: { question: string }[] }): void {
    const client = this.#client;
    if (!client) return;
    client.question
      .reply({ requestID: request.id, directory, answers: request.questions.map(() => [UNANSWERED]) }, { throwOnError: true })
      .catch(() => client.question.reject({ requestID: request.id, directory }).catch(() => {}));
    this.#emit({ kind: "question", sessionId: request.sessionID, questions: request.questions.map((q) => q.question) });
  }

  /** Restarts the engine with backoff when it dies on its own (design D4). */
  async #onExit(generation: number): Promise<void> {
    if (generation !== this.#generation) return; // stopped or restarted on purpose
    this.#generation++;
    this.#server = undefined;
    this.#client = undefined;
    this.#emit({ kind: "interrupted" });
    const max = this.opts.maxRestarts ?? 5;
    while (this.#restarts < max) {
      this.#restarts++;
      this.#setState("restarting");
      await Bun.sleep(Math.min(500 * 2 ** (this.#restarts - 1), 30_000));
      try {
        await this.ensureRunning();
        return;
      } catch {
        // try again
      }
    }
    this.#setState("failed", `engine crashed ${max} times; last error: ${this.#lastError ?? "unknown"}`);
  }

  async #shutdown(): Promise<void> {
    this.#generation++;
    const server = this.#server;
    this.#server = undefined;
    this.#client = undefined;
    if (this.#state === "running") this.#setState("stopped");
    if (server) {
      await this.opts.launcher?.stop?.().catch(() => {});
      await stopServer(server.proc);
    }
  }

  #setState(state: EngineProcessState, message?: string): void {
    this.#state = state;
    this.#emit({ kind: "state", state, ...(message ? { message } : {}) });
  }

  #emit(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
