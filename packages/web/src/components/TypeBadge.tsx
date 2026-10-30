import type { ProjectType, WorkspaceKind } from "@studio/shared";

const TYPE_LABEL: Record<ProjectType, string> = {
  greenfield: "greenfield",
  brownfield: "brownfield",
  inicializado: "inicializado",
};

export function TypeBadge({ type }: { type: ProjectType }) {
  return <span className={`badge badge-${type}`}>{TYPE_LABEL[type]}</span>;
}

export function KindBadge({ kind }: { kind: WorkspaceKind }) {
  return <span className="badge badge-kind">{kind === "mono" ? "mono-repo" : "multi-repo"}</span>;
}
