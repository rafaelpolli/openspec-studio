import type { Assumption, DecisionCheckpoint } from "./decisions.ts";
import type { ValidationIssue } from "./openspec.ts";
import { z } from "zod";

export const WorkspaceKind = z.enum(["mono", "multi"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

export const ProjectType = z.enum(["greenfield", "brownfield", "inicializado"]);
export type ProjectType = z.infer<typeof ProjectType>;

export const WorkspaceMember = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;

export const Workspace = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: WorkspaceKind,
  rootPath: z.string().min(1),
  storeId: z.string().min(1).nullable(),
  members: z.array(WorkspaceMember).min(1),
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

export const ApiErrorCode = z.enum([
  "forbidden",
  "not_found",
  "invalid_input",
  "conflict",
  "cli_unavailable",
  "cli_error",
  "engine_unavailable",
  "git_failed",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const WorkspaceView = Workspace.extend({
  projectType: ProjectType,
  hasOpenSpec: z.boolean(),
  /** The init wizard applies: no OpenSpec root yet, or a store without the OpenCode commands. */
  needsInit: z.boolean(),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const MemberIssue = z.object({
  member: z.string(),
  issue: z.enum(["store_not_declared", "declares_other_store"]),
  message: z.string(),
});
export type MemberIssue = z.infer<typeof MemberIssue>;

export const RegisterMonoInput = z.object({
  kind: z.literal("mono"),
  path: z.string().min(1),
  name: z.string().min(1).optional(),
});

export const RegisterMultiInput = z.object({
  kind: z.literal("multi"),
  storeId: z.string().min(1),
  members: z.array(z.string().min(1)).min(1),
  name: z.string().min(1).optional(),
});

export const RegisterWorkspaceInput = z.discriminatedUnion("kind", [RegisterMonoInput, RegisterMultiInput]);
export type RegisterWorkspaceInput = z.infer<typeof RegisterWorkspaceInput>;

export const RegisterWorkspaceResult = z.object({
  workspace: WorkspaceView,
  issues: z.array(MemberIssue),
});
export type RegisterWorkspaceResult = z.infer<typeof RegisterWorkspaceResult>;

export const CreateStoreInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes"),
  path: z.string().min(1),
  /** Initialize a Git repository with a first commit (needs a Git identity). */
  initGit: z.boolean().default(true),
});
export type CreateStoreInput = z.infer<typeof CreateStoreInput>;

export const SpecOverview = z.object({
  id: z.string(),
  purpose: z.string(),
  requirementCount: z.number(),
});
export type SpecOverview = z.infer<typeof SpecOverview>;

export interface ArtifactFile {
  /** Path relative to the change folder, e.g. "specs/auth/spec.md". */
  path: string;
  content: string;
}

export interface SystemStatus {
  openspec: { available: true; version: string } | { available: false; message: string };
}

export const ValidateInput = z.object({ item: z.string().min(1).optional() });

/** Where an artifact stands in the guided proposal (spec: guided-proposal). */
export const ProposalState = z.enum([
  "bloqueado",
  "pronto",
  "gerando",
  "aguardando_aprovacao",
  "aprovado",
  "a_revisar",
  "ignorado",
]);
export type ProposalState = z.infer<typeof ProposalState>;

export interface ProposalArtifact {
  id: string;
  requires: string[];
  state: ProposalState;
  /** Dependencies that keep it blocked (not written or not approved). */
  waitingOn: string[];
  /** Validation issues that concern this artifact's files. */
  issues: ValidationIssue[];
  /** What the agent decided on its own in the last generation or adjustment (add-proposal-decisions). */
  assumptions?: Assumption[];
  /** The checkpoint's answers changed after this artifact was generated: why it is "a revisar". */
  staleDecisions?: boolean;
}

export interface ProposalView {
  change: string;
  description: string | null;
  artifacts: ProposalArtifact[];
  /** True while "gerar o resto" is running. */
  autoRunning: boolean;
  /** Artifact being generated right now, if any. */
  generating: string | null;
  /** Outcome of the last generation that needs the user's attention. */
  notice: string | null;
  /** The decisions checkpoint; null for a change without one (add-proposal-decisions). */
  decisions: DecisionCheckpoint | null;
}

export const CreateChangeInput = z.object({
  description: z.string().min(3),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use kebab-case: letras minúsculas, dígitos e hífens"),
});
