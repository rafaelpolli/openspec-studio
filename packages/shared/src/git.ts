// Git of a workspace's members and store, done by the app (add-git-commits).

/** Where a Git setting comes from, as `git config --show-scope` reports it. */
export type GitConfigScope = "local" | "global" | "system" | "worktree" | "command";

export interface GitIdentity {
  name?: string;
  email?: string;
  nameScope?: GitConfigScope;
  emailScope?: GitConfigScope;
}

/** A folder the app does Git for: a member, or the root when it is not inside a member. */
export interface GitArea {
  name: string;
  path: string;
  git: boolean;
  /** Top of the repository the folder is in. */
  top?: string;
  /** Current branch; null when HEAD is detached. */
  branch?: string | null;
  /** True when the folder is a subfolder of a larger repository. */
  nested?: boolean;
  /** Files with uncommitted changes inside the folder. */
  pending: number;
  identity: GitIdentity;
}

export interface GitState {
  areas: GitArea[];
  /** A task of the workspace runs or waits for review: "Commitar pendências" is unavailable. */
  busy: boolean;
}

/** A file that would go into the initial commit. */
export interface InitFile {
  path: string;
  size: number;
}

export interface InitPreview {
  /** The `.gitignore` the init would leave: the existing one plus the proposed lines. */
  gitignore: string;
  /** The folder already has a `.gitignore`: its content must stay as a prefix. */
  existing: boolean;
  /** Lines proposed on top of the existing `.gitignore`. */
  additions: string[];
  /** Files of the initial commit (at most the first 500). */
  files: InitFile[];
  fileCount: number;
  totalBytes: number;
  /** Files whose name suggests secrets, and whether the `.gitignore` leaves them out. */
  secrets: { path: string; ignored: boolean }[];
}

export type GitFailureKind = "identidade" | "assinatura" | "hook" | "outro";

/** Body of a 422: a Git action failed and nothing was changed. */
export interface GitFailure {
  error: { code: "git_failed"; message: string; kind: GitFailureKind; output: string };
}
