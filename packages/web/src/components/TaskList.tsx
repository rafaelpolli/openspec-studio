import type { TaskChecklist } from "@studio/shared";

export function TaskList({ checklist }: { checklist: TaskChecklist }) {
  if (checklist.total === 0) return <p className="empty">Sem tasks.</p>;
  return (
    <div className="tasks">
      {checklist.sections.map((section, i) => (
        <section key={`${section.title ?? ""}-${i}`}>
          {section.title && <h4>{section.title}</h4>}
          <ul>
            {section.tasks.map((task) => (
              <li key={task.line} className={task.done ? "task task-done" : "task"}>
                <span className="check" aria-label={task.done ? "concluída" : "pendente"}>
                  {task.done ? "✓" : "○"}
                </span>
                {task.id && <span className="task-id">{task.id}</span>} {task.text}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
