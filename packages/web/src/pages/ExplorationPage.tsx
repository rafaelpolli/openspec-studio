import { Link, useLocation } from "wouter";
import { ExplorationView } from "../components/ExplorationView.tsx";
import { useCreateExploration, useExploration, useExplorationActions, useRun } from "../queries.ts";
import { QueryState } from "./QueryState.tsx";

/** An exploration of the workspace, wired to the backend (add-workspace-explore). */
export function ExplorationPage({ id, x }: { id: string; x: string }) {
  const exploration = useExploration(id, x);
  const actions = useExplorationActions(id, x);
  const create = useCreateExploration(id);
  // The answer streams on the exploration's session, like a change's run (D1).
  const run = useRun(id, `explorar-${x}`, exploration.data?.busy ?? false);
  const [, navigate] = useLocation();
  const pending = Object.values(actions).find((m) => m.isPending);
  const error = Object.values(actions).find((m) => m.error)?.error ?? create.error;

  return (
    <main>
      <Link href={`/w/${id}`} className="muted">
        ← workspace
      </Link>
      {error && (
        <p className="banner banner-error" role="alert">
          {error.message}
        </p>
      )}
      <QueryState query={exploration}>
        {(e) => (
          <ExplorationView
            workspaceId={id}
            exploration={e}
            run={e.busy && run.data?.status === "rodando" ? run.data : undefined}
            busy={Boolean(pending)}
            actions={{
              send: (text) => actions.send.mutate(text),
              stop: () => actions.stop.mutate(undefined),
              rename: (title) => actions.rename.mutate(title),
              draft: () => actions.draft.mutate(undefined),
              toChange: (draft) => actions.toChange.mutate(draft, { onSuccess: (done) => navigate(`/w/${id}/changes/${done.change}`) }),
              discard: () => actions.discard.mutate(undefined),
              continueFrom: () => create.mutate(x, { onSuccess: (next) => navigate(`/w/${id}/explorations/${next.id}`) }),
            }}
          />
        )}
      </QueryState>
    </main>
  );
}
