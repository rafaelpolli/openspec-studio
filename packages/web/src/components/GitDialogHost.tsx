import type { GitArea } from "@studio/shared";
import { ApiRequestError } from "../api.ts";
import { useGitActions } from "../queries.ts";
import { InitDialog, PendingCommitDialog, type GitError } from "./GitPanel.tsx";

export type GitDialog = { area: GitArea; kind: "init" | "pending" };

export const asGitError = (err: unknown): GitError | undefined =>
  err instanceof ApiRequestError ? { message: err.message, git: err.git } : err instanceof Error ? { message: err.message } : undefined;

/** Opens the init or pending-commit dialog of an area, wired to the backend; `onDone` runs after it succeeds. */
export function GitDialogHost({ id, dialog, onClose, onDone }: { id: string; dialog: GitDialog; onClose: () => void; onDone?: () => void }) {
  const git = useGitActions(id);
  const { area } = dialog;
  const setIdentity = (name: string, email: string) => git.setIdentity.mutateAsync({ area: area.path, name, email });
  const finish = { onSuccess: () => (onClose(), onDone?.()) };
  if (dialog.kind === "init") {
    return (
      <InitDialog
        area={area}
        busy={git.init.isPending}
        error={asGitError(git.init.error)}
        onPreview={(gitignore) => git.preview(area.path, gitignore)}
        onInit={(gitignore, message, noVerify, identity) =>
          git.init.mutate({ area: area.path, gitignore, message, noVerify, ...(identity ? { identity } : {}) }, finish)
        }
        onCancel={onClose}
      />
    );
  }
  return (
    <PendingCommitDialog
      area={area}
      busy={git.commitPending.isPending}
      error={asGitError(git.commitPending.error)}
      onCommit={(message, noVerify) => git.commitPending.mutate({ area: area.path, message, noVerify }, finish)}
      onCancel={onClose}
      onIdentity={setIdentity}
    />
  );
}
