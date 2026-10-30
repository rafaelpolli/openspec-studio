import type { ArtifactState, ArtifactStatus } from "@studio/shared";

const STATE_LABEL: Record<ArtifactState, string> = {
  done: "concluído",
  ready: "pronto",
  blocked: "bloqueado",
  skipped: "ignorado",
};

/** Depth of each artifact in the dependency graph: 0 for roots, 1 + max(deps) otherwise. */
export function layers<T extends { id: string; requires: readonly string[] }>(artifacts: readonly T[]): T[][] {
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const depth = new Map<string, number>();
  const visit = (a: T, seen: Set<string>): number => {
    const known = depth.get(a.id);
    if (known !== undefined) return known;
    if (seen.has(a.id)) return 0; // cycle guard; schemas should not have cycles
    seen.add(a.id);
    const deps = a.requires.map((r) => byId.get(r)).filter((d): d is T => d !== undefined);
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => visit(dep, seen)));
    depth.set(a.id, d);
    return d;
  };
  const result: T[][] = [];
  for (const a of artifacts) {
    const d = visit(a, new Set());
    (result[d] ??= []).push(a);
  }
  return result;
}

export function ArtifactGraph({
  artifacts,
  selected,
  onSelect,
}: {
  artifacts: readonly ArtifactStatus[];
  selected?: string | undefined;
  onSelect?: (id: string) => void;
}) {
  return (
    <ol className="graph" aria-label="Artefatos da change">
      {layers(artifacts).map((layer, i) => (
        <li key={i} className="graph-layer">
          {layer.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`node node-${a.status}${a.id === selected ? " node-selected" : ""}`}
              data-state={a.status}
              onClick={() => onSelect?.(a.id)}
              title={a.requires.length ? `depende de: ${a.requires.join(", ")}` : "sem dependências"}
            >
              <span className="node-id">{a.id}</span>
              <span className="node-state">{STATE_LABEL[a.status]}</span>
            </button>
          ))}
        </li>
      ))}
    </ol>
  );
}
