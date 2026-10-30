import { z } from "zod";

/** Lifecycle of the embedded engine process. */
export const EngineProcessState = z.enum(["stopped", "starting", "running", "restarting", "failed"]);
export type EngineProcessState = z.infer<typeof EngineProcessState>;

/** What the UI shows (spec: agent-sessions, "Indicar disponibilidade do motor"). */
export const EngineAvailability = z.enum(["iniciando", "disponivel", "sem_provedor", "falhou"]);
export type EngineAvailability = z.infer<typeof EngineAvailability>;

export interface EngineStatus {
  availability: EngineAvailability;
  version: string;
  message?: string;
}

/** Normalized agent activity, independent of the OpenCode event format. */
export type AgentEvent =
  | { kind: "text"; sessionId: string; partId: string; delta: string }
  | { kind: "tool"; sessionId: string; callId: string; tool: string; status: string; title?: string }
  | { kind: "file"; directory: string; path: string }
  /** The agent asked the user something; the app answered it on the user's behalf (task 6.9). */
  | { kind: "question"; sessionId: string; questions: string[] }
  /** The agent asked to do something its rules leave to the user (apply sessions only, add-visual-apply D3). */
  | { kind: "permission"; sessionId: string; directory: string; request: PermissionRequest }
  | { kind: "idle"; sessionId: string }
  | { kind: "error"; sessionId?: string; name: string; message: string };

export type RunStatus = "rodando" | "concluido" | "cancelado" | "falhou";

/** Why a run failed, in terms the UI can explain (spec: agent-sessions, "Reportar falha do agente"). */
export type RunErrorKind = "autenticacao" | "limite" | "conexao" | "interrompido" | "outro";

export interface RunError {
  kind: RunErrorKind;
  message: string;
}

/** Live view of an agent run on a change: what the agent wrote and touched so far. */
export interface RunView {
  runId: string;
  sessionId: string;
  status: RunStatus;
  startedAt: string;
  /** Text parts in arrival order. */
  transcript: { partId: string; text: string }[];
  tools: { callId: string; tool: string; status: string; title?: string }[];
  files: string[];
  /** Questions the agent asked; nobody answers them in the app, so it was told to carry on. */
  questions?: string[];
  /** A permission request waiting for the user's answer (add-visual-apply D3). */
  permission?: PermissionRequest;
  error?: RunError;
  /** Writes the agent made outside the OpenSpec root (design D8). */
  violations?: WriteViolation[];
}

export interface WriteViolation {
  path: string;
  change: "criado" | "modificado" | "removido";
  /** True when the change was undone (the member was a clean Git repository). */
  reverted: boolean;
}

/** A provider as the UI sees it: never includes credentials (spec: "Proteger credenciais"). */
export interface ProviderView {
  id: string;
  name: string;
  configured: boolean;
  methods: { index: number; type: "api" | "oauth"; label: string }[];
  /** Models offered by the provider; listed only for configured providers. */
  models: { id: string; name: string }[];
}

export interface ProvidersResponse {
  providers: ProviderView[];
  /** "providerID/modelID", or null to use the engine's default. */
  defaultModel: string | null;
}

export interface OauthStart {
  url: string;
  /** "auto": the engine finishes on its own; "code": the user pastes a code back. */
  method: "auto" | "code";
  instructions: string;
}

/** What the agent asked permission for: the tool (e.g. `bash`) and what it would touch. */
export interface PermissionRequest {
  requestId: string;
  permission: string;
  /** For `bash`, the parts of the command that are not on the allowed list. */
  patterns: string[];
}

/** A change has a planning session and, once tasks run, an apply session (add-visual-apply D1). */
export type SessionKind = "plan" | "apply";

export type PermissionReply = "once" | "reject";
