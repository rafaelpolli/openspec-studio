import type { ProposalArtifact, ProposalState } from "@studio/shared";
import { layers } from "./ArtifactGraph.tsx";

export const PROPOSAL_LABEL: Record<ProposalState, string> = {
  bloqueado: "bloqueado",
  pronto: "pronto para gerar",
  gerando: "gerando…",
  aguardando_aprovacao: "aguardando aprovação",
  aprovado: "aprovado",
  a_revisar: "a revisar",
  ignorado: "ignorado",
};

/** The artifact graph of the guided proposal, colored by proposal state. */
export function ProposalGraph({
  artifacts,
  selected,
  onSelect,
}: {
  artifacts: readonly ProposalArtifact[];
  selected?: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <ol className="graph" aria-label="Artefatos da change">
      {layers(artifacts).map((layer, i) => (
        <li key={i} className="graph-layer">
          {layer.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`node pnode-${a.state}${a.id === selected ? " node-selected" : ""}`}
              data-state={a.state}
              onClick={() => onSelect(a.id)}
            >
              <span className="node-id">{a.id}</span>
              <span className="node-state">{PROPOSAL_LABEL[a.state]}</span>
              {a.issues.length > 0 && <span className="node-issues">{a.issues.length} problema(s)</span>}
            </button>
          ))}
        </li>
      ))}
    </ol>
  );
}
