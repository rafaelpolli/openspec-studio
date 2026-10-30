import type { ArchiveOutcome, BaselineReview, Capability, CapabilityStatus } from "@studio/shared";
import { useState } from "react";

export const CAPABILITY_LABEL: Record<CapabilityStatus, string> = {
  aguardando: "aguardando",
  gerando: "gerando",
  validando: "validando",
  pronta: "pronta para revisão",
  falhou: "falhou",
  cancelada: "cancelada",
  aprovada: "aprovada",
  descartada: "descartada",
  arquivada: "arquivada",
};

export interface BatchActions {
  open: (cap: string) => void;
  retry: (cap: string) => void;
  cancel: (cap: string) => void;
}

/** State of every capability in the batch (spec: "Progresso da geração em lote"). */
export function BatchProgress({
  capabilities,
  selected,
  actions,
}: {
  capabilities: readonly Capability[];
  selected?: string | undefined;
  actions: BatchActions;
}) {
  const count = (s: CapabilityStatus[]) => capabilities.filter((c) => s.includes(c.status)).length;
  return (
    <section aria-label="Geração em lote">
      <p className="muted">
        {count(["pronta", "aprovada", "arquivada"])} prontas · {count(["gerando", "validando"])} em andamento ·{" "}
        {count(["aguardando"])} na fila · {count(["falhou"])} com falha
      </p>
      <ul className="cards">
        {capabilities.map((c) => (
          <li key={c.name} className={`card capability${selected === c.name ? " capability-selected" : ""}`}>
            <div className="capability-head">
              <button type="button" className="link" onClick={() => actions.open(c.name)} aria-label={`Abrir ${c.name}`}>
                {c.name}
              </button>
              <span className={`badge cstate-${c.status}`} data-testid={`status-${c.name}`}>
                {CAPABILITY_LABEL[c.status]}
              </span>
              {(c.status === "aguardando" || c.status === "gerando") && (
                <button type="button" className="danger" onClick={() => actions.cancel(c.name)}>
                  Cancelar
                </button>
              )}
              {(c.status === "falhou" || c.status === "cancelada") && (
                <button type="button" onClick={() => actions.retry(c.name)}>
                  Tentar novamente
                </button>
              )}
            </div>
            <span className="muted">{c.description}</span>
            {c.error && (
              <span className="banner banner-error" role="alert">
                {c.error}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface ReviewActions {
  approve: () => void;
  adjust: (request: string) => void;
  discard: () => void;
}

/**
 * One baseline under review: requirements with the "inferido" badge and the
 * `arquivo:linha` evidence read from the design.md table (spec: "Qualidade da spec de baseline").
 */
export function BaselineReviewPanel({
  review,
  status,
  actions,
}: {
  review: BaselineReview;
  status: CapabilityStatus;
  actions: ReviewActions;
}) {
  const [request, setRequest] = useState("");
  return (
    <section className="artifact-panel" aria-label={`Revisão de ${review.capability}`}>
      <header className="panel-header">
        <h3>{review.change}</h3>
        <span className={`badge cstate-${status}`}>{CAPABILITY_LABEL[status]}</span>
      </header>
      {review.requirements.length === 0 && <p className="empty">A spec não tem requisitos.</p>}
      {review.requirements.map((r) => (
        <article key={r.name} className="requirement" aria-label={r.name}>
          <h4>
            {r.name} {r.inferred ? <span className="badge badge-inferido">inferido</span> : <span className="badge badge-testado">testado</span>}
          </h4>
          <p>{r.text}</p>
          {r.evidence.length > 0 ? (
            <ul className="evidence" aria-label={`Evidências de ${r.name}`}>
              {r.evidence.map((e) => (
                <li key={e}>
                  <code>{e}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Sem evidência registrada.</p>
          )}
        </article>
      ))}
      <details>
        <summary>Arquivos da change</summary>
        {review.files.map((f) => (
          <div key={f.path}>
            <p className="file-path">{f.path}</p>
            <pre className="artifact">{f.content}</pre>
          </div>
        ))}
      </details>
      <div className="actions">
        {status === "pronta" && (
          <button type="button" onClick={actions.approve}>
            Aprovar
          </button>
        )}
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (confirm(`Descartar ${review.change}? A change será removida do disco.`)) actions.discard();
          }}
        >
          Descartar
        </button>
      </div>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (request.trim()) {
            actions.adjust(request.trim());
            setRequest("");
          }
        }}
      >
        <input aria-label="Pedido de ajuste" placeholder="O que ajustar nesta baseline?" value={request} onChange={(e) => setRequest(e.target.value)} />
        <button type="submit" disabled={!request.trim()}>
          Pedir ajuste
        </button>
      </form>
    </section>
  );
}

/** Result of the batch archive: each baseline archived or its error. */
export function ArchiveResults({ outcomes }: { outcomes: readonly ArchiveOutcome[] }) {
  if (outcomes.length === 0) return <p className="muted">Nenhuma baseline aprovada para arquivar.</p>;
  return (
    <ul className="validation" aria-label="Resultado do archive">
      {outcomes.map((o) => (
        <li key={o.change} className="issue">
          <span className={o.ok ? "status-ok" : "status-error"}>{o.ok ? "arquivada" : "falhou"}</span> {o.change}
          {o.error && <span className="muted">: {o.error}</span>}
        </li>
      ))}
    </ul>
  );
}
