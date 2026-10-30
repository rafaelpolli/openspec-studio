import { Link } from "wouter";
import { KindBadge, TypeBadge } from "../components/TypeBadge.tsx";
import { useWorkspaces } from "../queries.ts";
import { QueryState } from "./QueryState.tsx";

export function WorkspacesPage() {
  const workspaces = useWorkspaces();
  return (
    <main>
      <header className="page-header">
        <h1>Workspaces</h1>
        <Link href="/new" className="button">
          Novo workspace
        </Link>
      </header>
      <QueryState query={workspaces}>
        {(list) =>
          list.length === 0 ? (
            <p className="empty">Nenhum workspace registrado. Comece registrando uma pasta ou um store.</p>
          ) : (
            <ul className="cards">
              {list.map((ws) => (
                <li key={ws.id} className="card">
                  <Link href={`/w/${ws.id}`} className="card-title">
                    {ws.name}
                  </Link>
                  <div className="badges">
                    <KindBadge kind={ws.kind} />
                    <TypeBadge type={ws.projectType} />
                  </div>
                  <code className="muted">{ws.rootPath}</code>
                  {ws.kind === "multi" && (
                    <span className="muted">membros: {ws.members.map((m) => m.name).join(", ")}</span>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </main>
  );
}
