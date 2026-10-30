import type { ChangeDraft, Exploration, ExplorationMessage, RunView } from "@studio/shared";
import { useState } from "react";
import Markdown from "react-markdown";
import { Link } from "wouter";
import { AgentStream } from "./AgentStream.tsx";
import { explorationTitle } from "./ExplorationList.tsx";

export interface ExplorationActions {
  send: (text: string) => void;
  stop: () => void;
  rename: (title: string) => void;
  draft: () => void;
  toChange: (draft: ChangeDraft) => void;
  discard: () => void;
  continueFrom: () => void;
}

const NOTE: Partial<Record<ExplorationMessage["status"], string>> = { interrompida: "interrompida", falhou: "falhou" };

function Message({ m }: { m: ExplorationMessage }) {
  const note = NOTE[m.status];
  return (
    <li className={`exploration-message from-${m.role}`}>
      <span className="muted">
        {m.role === "usuario" ? "Você" : "Agente"}
        {note && ` (${note})`}
      </span>
      {m.role === "agente" ? <Markdown>{m.text}</Markdown> : <p>{m.text}</p>}
    </li>
  );
}

function Title({ exploration, busy, onRename }: { exploration: Exploration; busy: boolean; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(exploration.title ?? "");
  if (!editing) {
    return (
      <div className="exploration-title">
        <h1>{explorationTitle(exploration)}</h1>
        <button type="button" className="link" disabled={busy} onClick={() => (setValue(exploration.title ?? ""), setEditing(true))}>
          Editar título
        </button>
      </div>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        onRename(value.trim());
        setEditing(false);
      }}
    >
      <input aria-label="Título da exploração" value={value} maxLength={80} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" disabled={!value.trim()}>
        Salvar título
      </button>
    </form>
  );
}

/** "Virar change": the agent's draft, reviewed by the user (spec: "Virar change"). */
export function DraftReview({
  draft,
  busy,
  onCreate,
  onRedraft,
  onCancel,
}: {
  draft: ChangeDraft;
  busy: boolean;
  onCreate: (draft: ChangeDraft) => void;
  onRedraft: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [decisions, setDecisions] = useState(draft.decisions);
  const set = (i: number, field: "question" | "answer", value: string) =>
    setDecisions((all) => all.map((d, n) => (n === i ? { ...d, [field]: value } : d)));
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(name) && description.trim().length >= 3 && decisions.every((d) => d.question.trim() && d.answer.trim());
  return (
    <form
      className="draft-review"
      aria-label="Virar change"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ name, description: description.trim(), decisions: decisions.map((d) => ({ question: d.question.trim(), answer: d.answer.trim() })) });
      }}
    >
      <h2>Virar change</h2>
      <label>
        Nome da change
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Descrição
        <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <fieldset className="draft-decisions">
        <legend>Decisões da conversa (entram respondidas no checkpoint)</legend>
        {decisions.length === 0 && <p className="muted">Nenhuma decisão.</p>}
        {decisions.map((d, i) => (
          <div key={i} className="draft-decision">
            <input aria-label={`Pergunta ${i + 1}`} value={d.question} onChange={(e) => set(i, "question", e.target.value)} />
            <input aria-label={`Resposta ${i + 1}`} value={d.answer} onChange={(e) => set(i, "answer", e.target.value)} />
            <button type="button" className="link" onClick={() => setDecisions((all) => all.filter((_, n) => n !== i))}>
              Remover
            </button>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => setDecisions((all) => [...all, { question: "", answer: "" }])}>
          Acrescentar decisão
        </button>
      </fieldset>
      <div className="actions">
        <button type="submit" disabled={busy || !valid}>
          Criar change
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onRedraft}>
          Pedir outro rascunho
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

/**
 * An exploration (spec: workspace-exploration): the conversation with the agent, its live
 * answer, the message box, the title, and "Virar change"; read-only once it is closed.
 */
export function ExplorationView({
  workspaceId,
  exploration,
  run,
  busy,
  actions,
}: {
  workspaceId: string;
  exploration: Exploration;
  /** The live run of the exploration's session, while an answer is coming. */
  run: RunView | undefined;
  /** A request to the backend is in flight. */
  busy: boolean;
  actions: ExplorationActions;
}) {
  const [text, setText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const active = exploration.status === "ativa";
  const working = busy || exploration.busy;
  const answered = exploration.messages.some((m) => m.role === "agente" && m.status === "concluida");
  const shown = exploration.messages.filter((m) => m.status !== "respondendo");

  return (
    <section className="exploration" aria-label="Exploração">
      <Title exploration={exploration} busy={working} onRename={actions.rename} />
      {exploration.status === "virou-change" && exploration.change && (
        <p className="banner">
          Virou a change <Link href={`/w/${workspaceId}/changes/${exploration.change}`}>{exploration.change}</Link>.
        </p>
      )}
      {exploration.status === "descartada" && <p className="banner">Exploração descartada.</p>}

      <ol className="exploration-messages">
        {shown.map((m) => (
          <Message key={m.id} m={m} />
        ))}
      </ol>
      {exploration.busy && run && <AgentStream run={run} onCancel={actions.stop} />}
      {exploration.busy && !run && (
        <div className="actions">
          <span className="muted">O agente está respondendo…</span>
          <button type="button" className="danger" onClick={actions.stop}>
            Parar
          </button>
        </div>
      )}

      {active && (
        <>
          <form
            className="exploration-input"
            onSubmit={(e) => {
              e.preventDefault();
              actions.send(text.trim());
              setText("");
            }}
          >
            <textarea aria-label="Mensagem" rows={3} value={text} placeholder="Escreva uma ideia, uma dúvida ou uma resposta ao agente" onChange={(e) => setText(e.target.value)} />
            <button type="submit" disabled={working || !text.trim()}>
              Enviar
            </button>
          </form>
          {exploration.draftError && (
            <p className="banner banner-error" role="alert">
              Não foi possível montar o rascunho: {exploration.draftError}
            </p>
          )}
          {reviewing && exploration.draft && !exploration.busy ? (
            <DraftReview
              key={JSON.stringify(exploration.draft)}
              draft={exploration.draft}
              busy={working}
              onCreate={actions.toChange}
              onRedraft={actions.draft}
              onCancel={() => setReviewing(false)}
            />
          ) : (
            <div className="actions">
              <button
                type="button"
                disabled={working || !answered}
                onClick={() => {
                  setReviewing(true);
                  actions.draft();
                }}
              >
                Virar change
              </button>
              <button type="button" className="secondary" disabled={working} onClick={actions.discard}>
                Descartar
              </button>
            </div>
          )}
        </>
      )}
      {!active && (
        <div className="actions">
          <button type="button" className="secondary" onClick={actions.continueFrom}>
            Continuar a partir de…
          </button>
        </div>
      )}
    </section>
  );
}
