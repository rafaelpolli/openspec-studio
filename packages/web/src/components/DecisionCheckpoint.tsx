import { answerText, type Decision, type DecisionAnswer, type DecisionCheckpoint as Checkpoint } from "@studio/shared";
import { useState } from "react";

/** One decision's choice in the form: an option index, or the user's own text. */
type Choice = { option: number } | { own: string };

const ORIGIN = { recomendada: "recomendada", opcao: "outra opção", propria: "resposta própria" } as const;

function initialChoice(d: Decision, answer: DecisionAnswer | undefined): Choice {
  if (!answer || answer.kind === "recomendada") return { option: d.recommended };
  return answer.kind === "opcao" ? { option: answer.option } : { own: answer.text };
}

function toAnswer(d: Decision, choice: Choice): DecisionAnswer {
  if ("own" in choice) return { id: d.id, kind: "propria", text: choice.own.trim() };
  return choice.option === d.recommended ? { id: d.id, kind: "recomendada" } : { id: d.id, kind: "opcao", option: choice.option };
}

/**
 * The decisions checkpoint before the proposal (spec: guided-proposal, "Levantar decisões antes de
 * gerar"): the agent's open decisions, answered by the user or skipped; later, a summary that can
 * be edited, which sends the generated artifacts to "a revisar".
 */
export function DecisionCheckpoint({
  checkpoint,
  generated,
  busy,
  onAnswer,
  onSkip,
  onRetry,
}: {
  checkpoint: Checkpoint;
  /** How many artifacts are already written: editing an answer sends them to "a revisar". */
  generated: number;
  busy: boolean;
  onAnswer: (answers: DecisionAnswer[]) => void;
  onSkip: () => void;
  onRetry: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const { status, decisions } = checkpoint;

  if (status === "levantando") {
    return (
      <section className="decisions" aria-label="Decisões da change">
        <h2>Decisões</h2>
        <p className="muted">O agente está lendo a descrição e o código para levantar as decisões em aberto…</p>
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={onSkip}>
            Pular
          </button>
        </div>
      </section>
    );
  }
  if (status === "falhou") {
    return (
      <section className="decisions" aria-label="Decisões da change">
        <h2>Decisões</h2>
        <p className="banner banner-error" role="alert">
          Não foi possível levantar as decisões: {checkpoint.error}
        </p>
        <div className="actions">
          <button type="button" disabled={busy} onClick={onRetry}>
            Tentar de novo
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={onSkip}>
            Pular
          </button>
        </div>
      </section>
    );
  }
  if (status === "pulado") {
    return (
      <section className="decisions" aria-label="Decisões da change">
        <p className="muted">Decisões puladas: os artefatos são gerados sem respostas do checkpoint.</p>
      </section>
    );
  }
  if (status === "respondido" && decisions.length === 0) {
    return (
      <section className="decisions" aria-label="Decisões da change">
        <p className="muted">O agente não encontrou decisões a tomar antes do proposal.</p>
      </section>
    );
  }
  if (status === "respondido" && !editing) {
    return (
      <section className="decisions" aria-label="Decisões da change">
        <h2>Decisões</h2>
        <ul className="decision-summary">
          {decisions.map((d) => {
            const answer = checkpoint.answers.find((a) => a.id === d.id);
            return (
              <li key={d.id}>
                <strong>{d.question}</strong> {answerText(d, answer)}
                {answer && (
                  <span className="muted"> ({d.source === "exploracao" && answer.kind === "recomendada" ? "da exploração" : ORIGIN[answer.kind]})</span>
                )}
              </li>
            );
          })}
        </ul>
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(true)}>
            Editar respostas
          </button>
        </div>
      </section>
    );
  }
  return (
    <DecisionForm
      checkpoint={checkpoint}
      editing={editing}
      generated={generated}
      busy={busy}
      onSubmit={(answers) => {
        onAnswer(answers);
        setEditing(false);
      }}
      onSkip={onSkip}
      onCancel={() => setEditing(false)}
    />
  );
}

function DecisionForm({
  checkpoint,
  editing,
  generated,
  busy,
  onSubmit,
  onSkip,
  onCancel,
}: {
  checkpoint: Checkpoint;
  editing: boolean;
  generated: number;
  busy: boolean;
  onSubmit: (answers: DecisionAnswer[]) => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const { decisions } = checkpoint;
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(decisions.map((d) => [d.id, initialChoice(d, checkpoint.answers.find((a) => a.id === d.id))])),
  );
  const set = (id: string, choice: Choice) => setChoices((c) => ({ ...c, [id]: choice }));
  const incomplete = decisions.some((d) => {
    const c = choices[d.id]!;
    return "own" in c && !c.own.trim();
  });
  return (
    <form
      className="decisions"
      aria-label="Decisões da change"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(decisions.map((d) => toAnswer(d, choices[d.id]!)));
      }}
    >
      <h2>Decisões</h2>
      <p className="muted">
        O agente levantou {decisions.length === 1 ? "uma decisão" : `${decisions.length} decisões`} antes de escrever o proposal. As
        respostas entram no pedido de todos os artefatos.
      </p>
      {editing && generated > 0 && (
        <p className="banner banner-warn">
          Mudar uma resposta manda para "a revisar" {generated === 1 ? "o artefato já gerado" : `os ${generated} artefatos já gerados`}.
        </p>
      )}
      {decisions.map((d) => {
        const c = choices[d.id]!;
        return (
          <fieldset key={d.id} className="decision">
            <legend>
              {d.question}
              {d.source === "exploracao" && <span className="badge">da exploração</span>}
            </legend>
            {d.why && <p className="muted">{d.why}</p>}
            {d.options.map((o, i) => (
              <label key={i} className="decision-option">
                <input type="radio" name={d.id} checked={"option" in c && c.option === i} onChange={() => set(d.id, { option: i })} />
                {o.label}
                {i === d.recommended && d.source !== "exploracao" && <span className="badge">recomendada</span>}
                {o.description && <span className="muted"> {o.description}</span>}
              </label>
            ))}
            <label className="decision-option">
              <input type="radio" name={d.id} checked={"own" in c} onChange={() => set(d.id, { own: "own" in c ? c.own : "" })} />
              Outra resposta
            </label>
            {"own" in c && (
              <input aria-label={`Outra resposta para ${d.question}`} value={c.own} onChange={(e) => set(d.id, { own: e.target.value })} />
            )}
          </fieldset>
        );
      })}
      <div className="actions">
        <button type="submit" disabled={busy || incomplete}>
          Salvar respostas
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => onSubmit(decisions.map((d) => ({ id: d.id, kind: "recomendada" as const })))}
        >
          Aceitar recomendações
        </button>
        {editing ? (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancelar
          </button>
        ) : (
          <button type="button" className="secondary" disabled={busy} onClick={onSkip}>
            Pular
          </button>
        )}
      </div>
    </form>
  );
}
