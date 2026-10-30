import type { ExplorationStatus, ExplorationSummary } from "@studio/shared";
import { Link } from "wouter";

const STATUS: Record<ExplorationStatus, string> = { ativa: "ativa", "virou-change": "virou change", descartada: "descartada" };

/** The title, or the first words of the first message while there is none (D3). */
export const explorationTitle = (e: Pick<ExplorationSummary, "title" | "preview">) => e.title ?? (e.preview || "Exploração sem mensagens");

/** The workspace's explorations (spec: workspace-exploration, "Lista de explorações"). */
export function ExplorationList({
  workspaceId,
  explorations,
  creating,
  onCreate,
}: {
  workspaceId: string;
  explorations: readonly ExplorationSummary[];
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <section className="explorations" aria-label="Explorações">
      <div className="section-head">
        <h2>Explorações</h2>
        <button type="button" disabled={creating} onClick={onCreate}>
          Nova exploração
        </button>
      </div>
      {explorations.length === 0 ? (
        <p className="muted">Pense uma ideia com o agente antes de criar a change.</p>
      ) : (
        <ul className="exploration-list">
          {explorations.map((e) => (
            <li key={e.id}>
              <Link href={`/w/${workspaceId}/explorations/${e.id}`}>{explorationTitle(e)}</Link>
              <span className={`badge exploration-${e.status}`}>{STATUS[e.status]}</span>
              <span className="muted">{new Date(e.updatedAt).toLocaleString("pt-BR")}</span>
              {e.change && (
                <Link href={`/w/${workspaceId}/changes/${e.change}`} className="muted">
                  → {e.change}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
