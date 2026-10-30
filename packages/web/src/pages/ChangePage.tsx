import type { MemberWarning } from "@studio/shared";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { AgentStream } from "../components/AgentStream.tsx";
import { ApplyPanel } from "../components/ApplyPanel.tsx";
import { asGitError, GitDialogHost, type GitDialog } from "../components/GitDialogHost.tsx";
import { EnvironmentStatusBox } from "../components/EnvironmentPanel.tsx";
import { ArtifactPanel } from "../components/ArtifactPanel.tsx";
import { DecisionCheckpoint } from "../components/DecisionCheckpoint.tsx";
import { AiButton } from "../components/EngineBanner.tsx";
import { ProposalGraph } from "../components/ProposalGraph.tsx";
import { ValidationPanel } from "../components/ValidationPanel.tsx";
import { VerificationPanel } from "../components/VerificationPanel.tsx";
import { ApiRequestError } from "../api.ts";
import {
  useApply,
  useApplyActions,
  useArtifact,
  useCancelRun,
  useEnvironmentActions,
  useEnvironmentStatus,
  useEngine,
  useGit,
  useGitActions,
  useProposal,
  useProposalActions,
  useRun,
  useValidate,
  useVerification,
  useVerificationActions,
} from "../queries.ts";
import { QueryState } from "./QueryState.tsx";

export function ChangePage({ id, change }: { id: string; change: string }) {
  const proposal = useProposal(id, change);
  const apply = useApply(id, change);
  const applyActions = useApplyActions(id, change);
  const environment = useEnvironmentStatus(id);
  const env = useEnvironmentActions(id);
  const [warnings, setWarnings] = useState<{ mode: "proxima" | "todas"; list: MemberWarning[] } | undefined>();
  const git = useGit(id);
  const gitActions = useGitActions(id);
  const [gitDialog, setGitDialog] = useState<GitDialog | undefined>();
  const [commitTask, setCommitTask] = useState<string | undefined>();
  const engine = useEngine();
  const run = useRun(id, change);
  const cancel = useCancelRun(id, change);
  const validate = useValidate(id);
  const actions = useProposalActions(id, change);
  const [selected, setSelected] = useState<string | undefined>();

  const view = proposal.data;
  const current = selected ?? view?.generating ?? view?.artifacts.find((a) => a.state !== "aprovado")?.id ?? view?.artifacts[0]?.id;
  const artifact = useArtifact(id, change, current);
  const pending = Object.values(actions).some((m) => m.isPending);
  const busy = pending || run.data?.status === "rodando" || Boolean(view?.autoRunning);
  const canAuto = view?.artifacts.some((a) => a.state === "pronto") && !view.autoRunning;
  // A failed "Aceitar e commitar" is shown in the task's review, not in the page banner.
  const error =
    Object.values(actions).find((m) => m.error)?.error ??
    Object.entries(applyActions).find(([name, m]) => name !== "commit" && m.error)?.[1].error;
  const commitError = applyActions.commit.error && commitTask ? { task: commitTask, ...asGitError(applyActions.commit.error)! } : undefined;
  // Each warning opens the action that resolves it; afterwards the members are checked again.
  const resolveWarning = (w: MemberWarning) => {
    const area = git.data?.areas.find((a) => a.name === w.member);
    if (area) setGitDialog({ area, kind: w.kind === "sem-git" ? "init" : "pending" });
  };
  const recheck = async () => {
    if (!warnings) return;
    const { warnings: list } = await applyActions.check.mutateAsync();
    setWarnings(list.length > 0 ? { mode: warnings.mode, list } : undefined);
  };
  const applyBusy = Object.values(applyActions).some((m) => m.isPending) || run.data?.status === "rodando";
  // Members are checked first; warnings need the user's confirmation (spec: "Git como rede de segurança").
  const runApply = async (mode: "proxima" | "todas") => {
    const { warnings: list } = await applyActions.check.mutateAsync();
    if (list.length > 0) setWarnings({ mode, list });
    else applyActions.run.mutate({ mode, confirmed: false });
  };

  return (
    <main>
      <header className="page-header">
        <div>
          <Link href={`/w/${id}`} className="muted">
            ← workspace
          </Link>
          <h1>{change}</h1>
          {view?.description && <p className="lead">{view.description}</p>}
        </div>
        <div className="actions">
          <AiButton status={engine.data} disabled={busy || !canAuto} onClick={() => actions.generateRest.mutate(undefined)}>
            {view?.autoRunning ? "Gerando o resto…" : "Gerar o resto automaticamente"}
          </AiButton>
          <button type="button" className="secondary" onClick={() => validate.mutate(change)} disabled={validate.isPending}>
            Validar
          </button>
        </div>
      </header>

      {view?.notice && <p className="banner banner-warn">{view.notice}</p>}
      {error && (
        <p className="banner banner-error" role="alert">
          {error.message}
        </p>
      )}
      {run.data && <AgentStream run={run.data} onCancel={() => cancel.mutate()} />}
      {validate.data && <ValidationPanel report={validate.data} />}

      <QueryState query={proposal}>
        {(v) => (
          <>
            {v.decisions && (
              <DecisionCheckpoint
                checkpoint={v.decisions}
                generated={v.artifacts.filter((a) => ["aguardando_aprovacao", "aprovado", "a_revisar"].includes(a.state)).length}
                busy={busy}
                onAnswer={(answers) => actions.answerDecisions.mutate(answers)}
                onSkip={() => actions.skipDecisions.mutate(undefined)}
                onRetry={() => actions.retryDecisions.mutate(undefined)}
              />
            )}
            <ProposalGraph artifacts={v.artifacts} selected={current} onSelect={setSelected} />
            <div className="columns">
              {current && (
                <QueryState query={artifact}>
                  {(files) => {
                    const a = v.artifacts.find((x) => x.id === current)!;
                    return (
                      <ArtifactPanel
                        key={`${a.id}:${files.map((f) => f.content.length).join(",")}`}
                        artifact={a}
                        files={files}
                        engine={engine.data}
                        busy={busy}
                        actions={{
                          generate: () => actions.generate.mutate(a.id),
                          approve: () => actions.approve.mutate(a.id),
                          fix: () => actions.fix.mutate(a.id),
                          save: (path, content) => actions.save.mutate({ artifact: a.id, path, content }),
                          adjust: (request) => actions.adjust.mutate({ artifact: a.id, request }),
                        }}
                      />
                    );
                  }}
                </QueryState>
              )}
              <QueryState query={apply}>
                {(state) => (
                  <div>
                    {environment.data && (
                      <EnvironmentStatusBox
                        status={environment.data}
                        busy={state.running || env.stop.isPending || env.rebuild.isPending}
                        onStop={() => env.stop.mutate()}
                        onRebuild={() => env.rebuild.mutate()}
                        onUseLocal={() => env.save.mutate({ mode: "local", idleMinutes: 30 })}
                      />
                    )}
                    {gitDialog && (
                      <GitDialogHost id={id} dialog={gitDialog} onClose={() => setGitDialog(undefined)} onDone={() => void recheck()} />
                    )}
                    <ApplyPanel
                      state={state}
                      warnings={warnings?.list}
                      busy={applyBusy}
                      commitError={commitError}
                      actions={{
                        run: (mode) => void runApply(mode).catch(() => {}), // shown through the check's error
                        confirm: () => {
                          if (warnings) applyActions.run.mutate({ mode: warnings.mode, confirmed: true });
                          setWarnings(undefined);
                        },
                        dismiss: () => setWarnings(undefined),
                        stop: () => applyActions.stop.mutate(),
                        accept: (task) => applyActions.accept.mutate(task),
                        undo: (task) => applyActions.undo.mutate(task),
                        adjust: (task, request) => applyActions.adjust.mutate({ task, request }),
                        reply: (requestId, reply) => applyActions.reply.mutate({ requestId, reply }),
                        commit: (task, message, noVerify) => {
                          setCommitTask(task);
                          applyActions.commit.mutate({ task, message, noVerify });
                        },
                        resolveWarning,
                        // The repos without an author get the one the user typed, then the commit is retried.
                        setIdentity: (name, email) =>
                          Promise.all(
                            (git.data?.areas ?? [])
                              .filter((a) => a.git && (!a.identity.name || !a.identity.email))
                              .map((a) => gitActions.setIdentity.mutateAsync({ area: a.path, name, email })),
                          ),
                      }}
                    />
                  </div>
                )}
              </QueryState>
            </div>
            <VerificationHost id={id} change={change} />
          </>
        )}
      </QueryState>
    </main>
  );
}

/** The verification panel wired to the backend; after the archive the app goes back to the workspace. */
function VerificationHost({ id, change }: { id: string; change: string }) {
  const verification = useVerification(id, change);
  const actions = useVerificationActions(id, change);
  const [, navigate] = useLocation();
  const [committing, setCommitting] = useState(false);
  const [archived, setArchived] = useState(false);
  const back = () => navigate(`/w/${id}`);
  const failure = actions.archiveCommit.error ?? actions.archive.error;
  const archiveError = failure ? { ...asGitError(failure)!, archived: archived || (failure instanceof ApiRequestError && failure.archived) } : undefined;
  const itemActions = [actions.run, actions.stop, actions.check, actions.uncheck, actions.justify, actions.testTask, actions.proof];
  const error = itemActions.find((m) => m.error)?.error?.message;
  const busy = [...itemActions, actions.archive, actions.archiveCommit].some((m) => m.isPending);
  // A missing change (just archived elsewhere) leaves no panel.
  if (verification.error instanceof ApiRequestError && verification.error.status === 400) return null;
  return (
    <QueryState query={verification}>
      {(state) => (
        <VerificationPanel
          change={change}
          state={state}
          busy={busy}
          error={error}
          archiveError={archiveError}
          committing={committing}
          onCommitDialog={(open) => {
            setCommitting(open);
            // Closing the dialog of an archived change: there is no change page to stay on.
            if (!open && archived) back();
          }}
          actions={{
            run: () => actions.run.mutate(undefined),
            stop: () => actions.stop.mutate(undefined),
            prove: (item) => actions.proof.mutate(item),
            check: (item, note) => actions.check.mutate({ item, ...(note ? { note } : {}) }),
            uncheck: (item) => actions.uncheck.mutate(item),
            justify: (item, text) => actions.justify.mutate({ item, text }),
            testTask: (item) => actions.testTask.mutate(item),
            archive: () => actions.archive.mutate({}, { onSuccess: back }),
            archiveCommit: (message, noVerify) => {
              if (archived) actions.archiveCommit.mutate({ message, noVerify }, { onSuccess: back });
              else {
                actions.archive.mutate(
                  { commit: { message, noVerify } },
                  {
                    onSuccess: back,
                    onError: (err) => {
                      if (err instanceof ApiRequestError && err.archived) setArchived(true);
                    },
                  },
                );
              }
            },
          }}
        />
      )}
    </QueryState>
  );
}
