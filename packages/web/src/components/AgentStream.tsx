import type { RunStatus, RunView } from "@studio/shared";
import Markdown from "react-markdown";

const STATUS_LABEL: Record<RunStatus, string> = {
  rodando: "Agente trabalhando…",
  concluido: "Concluído",
  cancelado: "Cancelado",
  falhou: "Falhou",
};

function shortPath(path: string): string {
  const i = path.indexOf("/openspec/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Live view of what the agent is writing and touching (spec: agent-sessions, "Streaming"). */
export function AgentStream({ run, onCancel }: { run: RunView; onCancel?: () => void }) {
  const writing = run.tools.filter((t) => t.status === "running");
  return (
    <section className={`agent agent-${run.status}`} aria-label="Atividade do agente">
      <header className="agent-header">
        <strong role="status">{STATUS_LABEL[run.status]}</strong>
        {writing.map((t) => (
          <span key={t.callId} className="muted">
            {" "}
            {t.tool}: {t.title ?? "…"}
          </span>
        ))}
        {run.status === "rodando" && onCancel && (
          <button type="button" className="danger" onClick={onCancel}>
            Parar
          </button>
        )}
      </header>
      {run.status === "cancelado" && <p className="muted">A etapa ficou incompleta.</p>}
      {run.error && (
        <p className="banner banner-error" role="alert">
          {run.error.message}
        </p>
      )}
      {run.transcript.length > 0 && (
        <div className="markdown agent-text">
          {run.transcript.map((part) => (
            <Markdown key={part.partId}>{part.text}</Markdown>
          ))}
        </div>
      )}
      {run.questions && run.questions.length > 0 && (
        <div>
          <h4>Perguntas do agente</h4>
          <p className="muted">
            Não há como responder durante a geração: o agente seguiu com a opção mais razoável. Revise o artefato ou
            peça um ajuste.
          </p>
          <ul className="agent-questions">
            {run.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {run.files.length > 0 && (
        <div>
          <h4>Arquivos escritos</h4>
          <ul className="agent-files">
            {run.files.map((f) => (
              <li key={f}>
                <code>{shortPath(f)}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
