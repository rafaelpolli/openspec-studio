import type { PermissionRequest, RunView } from "./engine.ts";

// Apply: running a change's tasks with the agent (add-visual-apply).

/** One file a task created, changed or removed, with its unified diff. */
export interface FileChange {
  /** Path relative to the member. */
  path: string;
  change: "criado" | "modificado" | "removido";
  patch: string;
}

/** What a task changed in one member. */
export interface MemberDiff {
  member: string;
  /** False when the member is not in Git: no diff and no undo, only the files the agent wrote. */
  git: boolean;
  files: FileChange[];
  /** Absolute paths the agent reported writing, for members without Git. */
  written?: string[];
  /** Files of the diff that already had uncommitted changes before the task (add-git-commits D3). */
  dirtyBefore?: string[];
}

/** "Aceitar e commitar" for a task under review (add-git-commits). */
export interface TaskCommit {
  /** False when an earlier task still waits for review, or a file was dirty before the task. */
  allowed: boolean;
  reason?: string;
  /** Suggested message: `<change>: <id> <task text>`. */
  message: string;
  /** Repositories that will get a commit. */
  repos: string[];
  /** Repositories already committed by an earlier attempt that failed halfway. */
  done: string[];
}

export type ApplyTaskStatus =
  | "pendente"
  | "na-fila"
  | "rodando"
  | "aguardando-permissao"
  | "aguardando-revisao"
  | "aceita"
  | "incompleta";

export interface ApplyTask {
  /** Task number such as "1.2". */
  id: string;
  text: string;
  section: string | null;
  status: ApplyTaskStatus;
  /** What the agent said it did, from the end of its run. */
  summary?: string;
  diff?: MemberDiff[];
  error?: string;
  /** True for the most recent task under review: the only one that can be undone (D4). */
  canUndo?: boolean;
  commit?: TaskCommit;
}

/** A member check before running (spec: change-apply, "Git como rede de segurança"). */
export interface MemberWarning {
  member: string;
  kind: "sem-git" | "alteracoes-pendentes";
}

export interface ApplyState {
  change: string;
  hasTasks: boolean;
  /** True while a task runs or waits for a permission answer. */
  running: boolean;
  tasks: ApplyTask[];
  /** The agent run of the current (or last) task. */
  run?: RunView;
  permission?: PermissionRequest;
}

// Apply environment (add-apply-devcontainer).

/** Where a workspace's apply runs: on the machine, in a project devcontainer, or in a stock image (D7). */
export type EnvironmentMode = "local" | `devcontainer:${string}` | `imagem:${string}`;

export interface EnvironmentConfig {
  mode: EnvironmentMode;
  /** Minutes without tasks before the container is stopped (D5). */
  idleMinutes: number;
}

/** A `.devcontainer/devcontainer.json` found in the root or a member. */
export interface DevcontainerOption {
  member: string;
  /** Absolute path of the devcontainer.json. */
  path: string;
}

export interface StockImage {
  id: string;
  label: string;
  image: string;
}

export interface EnvironmentSettings {
  config: EnvironmentConfig;
  devcontainers: DevcontainerOption[];
  images: StockImage[];
  /** The option to suggest: the first devcontainer found, if any. */
  suggested?: EnvironmentMode;
}

export type EnvironmentState = "ausente" | "preparando" | "pronto" | "parado" | "falhou";

/** The live state of a workspace's apply container (spec: apply-environment, "Ciclo de vida do ambiente"). */
export interface EnvironmentStatus {
  mode: EnvironmentMode;
  state: EnvironmentState;
  /** The last lines of the preparation output. */
  output: string[];
  error?: string;
  /** The configuration changed since the container was prepared (D5). */
  needsRebuild?: boolean;
  /** The container's user did not get the machine's UID: files it creates may belong to someone else (D3). */
  uidMismatch?: boolean;
}
