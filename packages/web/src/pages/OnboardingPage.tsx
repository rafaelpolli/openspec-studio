import type { ArchiveOutcome, Estimate, OnboardingJob, WorkspaceView } from "@studio/shared";
import { useState } from "react";
import { Link } from "wouter";
import { AgentStream } from "../components/AgentStream.tsx";
import { ArchiveResults, BaselineReviewPanel, BatchProgress } from "../components/BatchProgress.tsx";
import { CapabilityCheckpoint, EstimateConfirm } from "../components/CapabilityCheckpoint.tsx";
import { AiButton } from "../components/EngineBanner.tsx";
import { InitWizard } from "../components/InitWizard.tsx";
import { KindBadge, TypeBadge } from "../components/TypeBadge.tsx";
import {
  useBaselineReview,
  useCancelRun,
  useEngine,
  useOnboarding,
  useOnboardingActions,
  useRun,
  useWorkspace,
} from "../queries.ts";
import { QueryState } from "./QueryState.tsx";

/** Onboarding: init wizard, then for brownfield discovery → checkpoint → batch → review → archive. */
export function OnboardingPage({ id }: { id: string }) {
  const workspace = useWorkspace(id);
  return (
    <main>
      <QueryState query={workspace}>
        {(ws) => (
          <>
            <header className="page-header">
              <div>
                <Link href={`/w/${id}`} className="muted">
                  ← {ws.name}
                </Link>
                <h1>Onboarding</h1>
                <div className="badges">
                  <KindBadge kind={ws.kind} />
                  <TypeBadge type={ws.projectType} />
                </div>
              </div>
            </header>
            <Onboarding ws={ws} />
          </>
        )}
      </QueryState>
    </main>
  );
}

function Onboarding({ ws }: { ws: WorkspaceView }) {
  const onboarding = useOnboarding(ws.id);
  const job = onboarding.data ?? undefined;
  const actions = useOnboardingActions(ws.id, job?.id);
  const engine = useEngine();

  if (ws.needsInit) {
    return (
      <section>
        <h2>1. Inicializar o OpenSpec</h2>
        <InitWizard
          workspace={ws}
          onInit={(language) => actions.init.mutate(language)}
          pending={actions.init.isPending}
          error={actions.init.error?.message}
        />
      </section>
    );
  }
  const canDiscover = !job || job.status === "descoberta_falhou" || job.status === "revisao";
  if (ws.projectType !== "brownfield" && !job) {
    return (
      <p className="empty">
        O workspace está inicializado e não há código existente para documentar. <Link href={`/w/${ws.id}/changes/new`}>Crie uma change</Link>.
      </p>
    );
  }
  return (
    <>
      {canDiscover && (
        <section>
          <h2>Descobrir capacidades</h2>
          <p className="muted">
            O agente lê o código de {ws.members.map((m) => m.name).join(", ")} e propõe a lista de capacidades. Nada é gerado
            antes da sua revisão.
          </p>
          {job?.status === "descoberta_falhou" && (
            <p className="banner banner-error" role="alert">
              A descoberta falhou: {job.error}
            </p>
          )}
          <AiButton status={engine.data} onClick={() => actions.discover.mutate()} disabled={actions.discover.isPending}>
            {job ? "Descobrir novamente" : "Descobrir capacidades"}
          </AiButton>
          {actions.discover.error && <p className="banner banner-error">{actions.discover.error.message}</p>}
        </section>
      )}
      {job && <JobView ws={ws} job={job} actions={actions} />}
    </>
  );
}

function JobView({
  ws,
  job,
  actions,
}: {
  ws: WorkspaceView;
  job: OnboardingJob;
  actions: ReturnType<typeof useOnboardingActions>;
}) {
  const [estimate, setEstimate] = useState<Estimate | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [outcomes, setOutcomes] = useState<ArchiveOutcome[] | undefined>();
  const engine = useEngine();
  const discoveryRun = useRun(ws.id, job.discoveryRun, job.status === "descobrindo");
  const cancelDiscovery = useCancelRun(ws.id, job.discoveryRun);
  const current = job.capabilities.find((c) => c.name === selected);
  const change = current?.changeName ?? "";
  const run = useRun(ws.id, change, !!change);
  const cancelRun = useCancelRun(ws.id, change);
  const review = useBaselineReview(
    ws.id,
    job.id,
    current?.name,
    current?.status === "pronta" || current?.status === "aprovada",
  );

  if (job.status === "descobrindo") {
    return (
      <section>
        <h2>Descobrindo capacidades…</h2>
        {discoveryRun.data && <AgentStream run={discoveryRun.data} onCancel={() => cancelDiscovery.mutate()} />}
      </section>
    );
  }
  if (job.status === "descoberta_falhou") return null;
  if (job.status === "checkpoint") {
    return (
      <section>
        <h2>2. Revisar a lista de capacidades</h2>
        {estimate ? (
          <EstimateConfirm
            estimate={estimate}
            onBack={() => setEstimate(undefined)}
            confirmDisabled={engine.data?.availability !== "disponivel"}
            pending={actions.start.isPending}
            onConfirm={() => actions.start.mutate(undefined, { onSuccess: () => setEstimate(undefined) })}
          />
        ) : (
          <CapabilityCheckpoint
            key={job.id}
            initial={job.capabilities}
            members={ws.members.map((m) => m.name)}
            pending={actions.checkpoint.isPending}
            error={actions.checkpoint.error?.message}
            onSubmit={(caps) => actions.checkpoint.mutate(caps, { onSuccess: setEstimate })}
          />
        )}
      </section>
    );
  }

  const approved = job.capabilities.filter((c) => c.status === "aprovada").length;
  return (
    <section>
      <h2>{job.status === "gerando" ? "3. Gerando baselines" : "4. Revisar e arquivar"}</h2>
      <div className="columns">
        <BatchProgress
          capabilities={job.capabilities}
          selected={selected}
          actions={{
            open: setSelected,
            retry: (c) => actions.retry.mutate(c),
            cancel: (c) => actions.cancel.mutate(c),
          }}
        />
        <div>
          {current && run.data && (current.status === "gerando" || current.status === "validando" || current.status === "falhou") && (
            <AgentStream run={run.data} onCancel={() => cancelRun.mutate()} />
          )}
          {current && review.data && (current.status === "pronta" || current.status === "aprovada") && (
            <BaselineReviewPanel
              review={review.data}
              status={current.status}
              actions={{
                approve: () => actions.approve.mutate(current.name),
                discard: () => actions.discard.mutate(current.name, { onSuccess: () => setSelected(undefined) }),
                adjust: (request) => actions.adjust.mutate({ name: current.name, request }),
              }}
            />
          )}
          {!current && <p className="muted">Abra uma capacidade para acompanhar o agente ou revisar a baseline.</p>}
        </div>
      </div>
      <div className="actions">
        <button
          type="button"
          disabled={approved === 0 || actions.archive.isPending}
          onClick={() => actions.archive.mutate(undefined, { onSuccess: setOutcomes })}
        >
          Arquivar {approved} aprovada(s)
        </button>
        {approved === 0 && job.status === "revisao" && (
          <span className="muted">
            Para arquivar, abra cada baseline pronta (botão "Abrir"), revise e clique em Aprovar.
          </span>
        )}
      </div>
      {outcomes && <ArchiveResults outcomes={outcomes} />}
    </section>
  );
}
