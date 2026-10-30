import type { SpecOverview } from "@studio/shared";
import { Link } from "wouter";

export function SpecList({ workspaceId, specs }: { workspaceId: string; specs: SpecOverview[] }) {
  if (specs.length === 0) {
    return (
      <p className="empty">
        Nenhuma spec ainda. As specs nascem quando uma change é arquivada ou durante o onboarding de um projeto
        existente.
      </p>
    );
  }
  return (
    <ul className="cards">
      {specs.map((spec) => (
        <li key={spec.id} className="card">
          <Link href={`/w/${workspaceId}/specs/${spec.id}`} className="card-title">
            {spec.id}
          </Link>
          <p>{spec.purpose}</p>
          <span className="muted">
            {spec.requirementCount} {spec.requirementCount === 1 ? "requisito" : "requisitos"}
          </span>
        </li>
      ))}
    </ul>
  );
}
