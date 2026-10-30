import type { ChangeSummary } from "@studio/shared";
import { Link } from "wouter";

export function ChangeList({ workspaceId, changes }: { workspaceId: string; changes: ChangeSummary[] }) {
  if (changes.length === 0) return <p className="empty">Nenhuma change ativa.</p>;
  return (
    <ul className="cards">
      {changes.map((change) => (
        <li key={change.name} className="card">
          <Link href={`/w/${workspaceId}/changes/${change.name}`} className="card-title">
            {change.name}
          </Link>
          <Progress done={change.completedTasks} total={change.totalTasks} />
        </li>
      ))}
    </ul>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  if (total === 0) return <span className="muted">sem tasks</span>;
  return (
    <span className="progress" aria-label={`${done} de ${total} tasks`}>
      <span className="progress-bar">
        <span className="progress-fill" style={{ width: `${(done / total) * 100}%` }} />
      </span>
      {`${done}/${total}`}
    </span>
  );
}
