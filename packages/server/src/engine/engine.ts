import type { AgentEvent, EngineProcessState, PermissionReply } from "@studio/shared";

export type EngineEvent =
  | { kind: "state"; state: EngineProcessState; message?: string }
  /** The engine process died; sessions that were running did not finish. */
  | { kind: "interrupted" }
  | AgentEvent;

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
}

export interface PromptOptions {
  directory: string;
  system?: string;
  model?: { providerID: string; modelID: string };
}

/** The agent engine boundary (design D4); OpenCode in production, a fake in tests. */
export interface Engine {
  readonly state: EngineProcessState;
  readonly version: string;
  readonly lastError: string | undefined;
  ensureRunning(): Promise<void>;
  createSession(opts: { directory: string; title?: string; permission?: PermissionRule[] }): Promise<string>;
  sessionExists(sessionId: string, directory: string): Promise<boolean>;
  /** Starts a prompt and returns immediately; progress and completion arrive as events. */
  prompt(sessionId: string, text: string, opts: PromptOptions): Promise<void>;
  abort(sessionId: string, directory: string): Promise<void>;
  /** Answers a pending permission request; `reject` hands the agent `message` as the reason. */
  replyPermission(requestId: string, directory: string, reply: PermissionReply, message?: string): Promise<void>;
  /** Providers the engine reports as connected (includes the built-in `opencode`). */
  connectedProviders(): Promise<string[]>;
  onEvent(listener: (event: EngineEvent) => void): () => void;
  restart(): Promise<void>;
  stop(): Promise<void>;
}
