import type { ArtifactFile, Assumption, EngineStatus, ProposalArtifact } from "@studio/shared";
import { useRef, useState } from "react";
import { ArtifactViewer } from "./ArtifactViewer.tsx";
import { AiButton } from "./EngineBanner.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { PROPOSAL_LABEL } from "./ProposalGraph.tsx";

export interface ArtifactActions {
  generate: () => void;
  approve: () => void;
  save: (path: string, content: string) => void;
  adjust: (request: string) => void;
  fix: () => void;
}

/** One artifact of the guided proposal with the actions its state allows (spec: guided-proposal). */
export function ArtifactPanel({
  artifact,
  files,
  engine,
  busy,
  actions,
}: {
  artifact: ProposalArtifact;
  files: ArtifactFile[];
  engine: EngineStatus | undefined;
  /** An agent run or request is in progress for this change. */
  busy: boolean;
  actions: ArtifactActions;
}) {
  const [editing, setEditing] = useState<ArtifactFile | undefined>();
  // A ref, not state: the editor reports edits outside React's render cycle, and Salvar must
  // always send the latest text.
  const draft = useRef("");
  const [request, setRequest] = useState("");
  const requestInput = useRef<HTMLInputElement>(null);
  const written = files.length > 0;
  const reviewable = artifact.state === "aguardando_aprovacao" || artifact.state === "a_revisar";

  if (editing) {
    return (
      <section className="artifact-panel">
        <h3>
          Editando <code>{editing.path}</code>
        </h3>
        <MarkdownEditor
          value={editing.content}
          onChange={(text) => (draft.current = text)}
          label={`Editor de ${editing.path}`}
        />
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setEditing(undefined)}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => {
              actions.save(editing.path, draft.current);
              setEditing(undefined);
            }}
          >
            Salvar
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="artifact-panel">
      <header className="panel-header">
        <h3>{artifact.id}</h3>
        <span className={`badge pstate-${artifact.state}`}>{PROPOSAL_LABEL[artifact.state]}</span>
      </header>

      {artifact.state === "bloqueado" &&
        (artifact.waitingOn.includes(DECISIONS_DEP) ? (
          <p className="muted">Responda ou pule as decisões da change antes de gerar.</p>
        ) : (
          <p className="muted">Depende de: {artifact.waitingOn.join(", ")} (precisam estar aprovados).</p>
        ))}
      {artifact.state === "a_revisar" &&
        (artifact.staleDecisions ? (
          <p className="banner banner-warn">Uma decisão da change mudou depois que este artefato foi gerado. Peça um ajuste e aprove de novo.</p>
        ) : (
          <p className="banner banner-warn">Um artefato do qual este depende mudou depois da aprovação. Revise e aprove de novo.</p>
        ))}

      {reviewable && artifact.assumptions && artifact.assumptions.length > 0 && (
        <Assumptions
          items={artifact.assumptions}
          busy={busy}
          onAdjust={(text) => {
            setRequest(`Sobre a suposição "${text}": `);
            requestInput.current?.focus();
          }}
        />
      )}

      {artifact.issues.length > 0 && (
        <div className="banner banner-error" role="alert">
          <strong>Validação do OpenSpec:</strong>
          <ul>
            {artifact.issues.map((i, n) => (
              <li key={n}>
                {i.path && <code>{i.path}</code>} {i.message}
              </li>
            ))}
          </ul>
          <AiButton status={engine} disabled={busy} onClick={actions.fix}>
            Pedir correção ao agente
          </AiButton>
        </div>
      )}

      <div className="actions">
        {artifact.state === "pronto" && (
          <AiButton status={engine} disabled={busy} onClick={actions.generate}>
            Gerar {artifact.id}
          </AiButton>
        )}
        {reviewable && (
          <button type="button" disabled={busy} onClick={actions.approve}>
            Aprovar
          </button>
        )}
        {written &&
          files.map((f) => (
            <button
              key={f.path}
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                draft.current = f.content;
                setEditing(f);
              }}
            >
              Editar{files.length > 1 ? ` ${f.path}` : ""}
            </button>
          ))}
      </div>

      {written && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            actions.adjust(request);
            setRequest("");
          }}
        >
          <input
            ref={requestInput}
            aria-label="Pedir ajuste ao agente"
            placeholder='Pedir ajuste, ex.: "remova a parte de autenticação do escopo"'
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
          <AiButton status={engine} type="submit" disabled={busy || request.trim().length < 3}>
            Pedir ajuste
          </AiButton>
        </form>
      )}

      <ArtifactViewer files={files} />
    </section>
  );
}

/** Shown in `waitingOn` while the first artifact waits for the decisions checkpoint (server: states.ts). */
const DECISIONS_DEP = "decisões";
const COLLAPSE_AFTER = 5;

/**
 * What the agent decided on its own (spec: guided-proposal, "Suposições do agente na aprovação"),
 * each with "Ajustar", which starts an adjustment request about it.
 */
function Assumptions({ items, busy, onAdjust }: { items: readonly Assumption[]; busy: boolean; onAdjust: (text: string) => void }) {
  const list = (
    <ul className="assumptions">
      {items.map((a, i) => (
        <li key={i}>
          <span>
            {a.text}
            {a.question && <span className="muted"> (pergunta do agente: {a.question})</span>}
          </span>
          <button type="button" className="link" disabled={busy} onClick={() => onAdjust(a.text)}>
            Ajustar
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label="Suposições do agente">
      {items.length > COLLAPSE_AFTER ? (
        <details>
          <summary>Suposições do agente ({items.length})</summary>
          {list}
        </details>
      ) : (
        <>
          <h4>Suposições do agente</h4>
          {list}
        </>
      )}
      <p className="muted">Ao aprovar, estas suposições ficam registradas como aceitas em decisions.md.</p>
    </section>
  );
}
