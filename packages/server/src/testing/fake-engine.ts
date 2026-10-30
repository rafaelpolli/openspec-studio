import type { EngineProcessState, PermissionReply } from "@studio/shared";
import type { Engine, EngineEvent, PermissionRule, PromptOptions } from "../engine/engine.ts";

export interface PromptCall {
  sessionId: string;
  text: string;
  opts: PromptOptions;
}

/** In-memory Engine for tests: records calls and lets the test emit agent events. */
export class FakeEngine implements Engine {
  state: EngineProcessState = "running";
  version = "0.0.0-fake";
  lastError: string | undefined;
  connected = ["opencode"];
  readonly sessions = new Map<string, string>();
  readonly prompts: PromptCall[] = [];
  readonly aborted: string[] = [];
  /** Called on each prompt; lets a test script the agent's behavior. */
  onPrompt: ((call: PromptCall, engine: FakeEngine) => void | Promise<void>) | undefined;
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  #next = 1;

  async ensureRunning(): Promise<void> {
    if (this.state !== "running") throw new Error(this.lastError ?? "engine not running");
  }

  readonly permissions = new Map<string, PermissionRule[] | undefined>();

  async createSession(opts: { directory: string; permission?: PermissionRule[] }): Promise<string> {
    const id = `ses_fake${this.#next++}_${crypto.randomUUID().slice(0, 8)}`;
    this.sessions.set(id, opts.directory);
    this.permissions.set(id, opts.permission);
    return id;
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async prompt(sessionId: string, text: string, opts: PromptOptions): Promise<void> {
    await this.ensureRunning();
    const call = { sessionId, text, opts };
    this.prompts.push(call);
    await this.onPrompt?.(call, this);
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
  }

  readonly permissionReplies: { requestId: string; reply: PermissionReply; message?: string }[] = [];

  async replyPermission(requestId: string, _directory: string, reply: PermissionReply, message?: string): Promise<void> {
    this.permissionReplies.push({ requestId, reply, ...(message ? { message } : {}) });
  }

  async connectedProviders(): Promise<string[]> {
    await this.ensureRunning();
    return this.connected;
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: EngineEvent): void {
    for (const l of this.#listeners) l(event);
  }

  setState(state: EngineProcessState, message?: string): void {
    this.state = state;
    if (state === "failed") this.lastError = message;
    this.emit({ kind: "state", state, ...(message ? { message } : {}) });
  }

  async restart(): Promise<void> {
    this.setState("running");
  }

  async stop(): Promise<void> {
    this.setState("stopped");
  }
}
