import { isConcern, type ItemResult, type VerificationItem, type VerificationState } from "@studio/shared";
import { useState } from "react";
import { GitFailure, type GitError } from "./GitPanel.tsx";

const RESULT: Record<ItemResult, string> = {
  aguardando: "aguardando",
  rodando: "rodando",
  coberto: "coberto",
  falhou: "falhou",
  "evidencia-invalida": "evidência inválida",
  "nao-executado": "não executado",
  "sem-teste": "sem teste",
  manual: "manual",
};

export interface VerificationActions {
  run: () => void;
  stop: () => void;
  prove: (item: string) => void;
  check: (item: string, note?: string) => void;
  uncheck: (item: string) => void;
  justify: (item: string, text: string) => void;
  testTask: (item: string) => void;
  /** Plain archive, after the confirmation. */
  archive: () => void;
  /** Archive and commit: the archive with its commit, or, once archived, the commit again. */
  archiveCommit: (message: string, noVerify: boolean) => void;
}

/** A failed archive; `archived` when only its commit failed. */
export type ArchiveError = GitError & { archived?: boolean | undefined };

function resultLabel(item: VerificationItem): string {
  if (item.result === "manual" && item.checked) return "manual (conferido)";
  return RESULT[item.result];
}

function proofLabel(item: VerificationItem): string | undefined {
  const p = item.proof;
  if (!p) return undefined;
  if (p.status === "rodando") return "provando…";
  if (p.status === "falhou") return `a prova falhou: ${p.error ?? ""}`;
  return p.result ? `prova ${p.result}` : undefined;
}

function Justify({ item, busy, onSave }: { item: VerificationItem; busy: boolean; onSave: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(item.justification ?? "");
  if (!open) {
    return (
      <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(true)}>
        Justificar
      </button>
    );
  }
  return (
    <div className="verification-justify">
      <label>
        Justificativa
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          onSave(text);
          setOpen(false);
        }}
      >
        Salvar justificativa
      </button>
    </div>
  );
}

function Item({
  item,
  busy,
  canProve,
  actions,
}: {
  item: VerificationItem;
  busy: boolean;
  canProve: boolean;
  actions: VerificationActions;
}) {
  const concern = isConcern(item);
  const proof = proofLabel(item);
  const outputs = [item.output, item.proof?.control && `Controle:\n${item.proof.control}`, item.proof?.before && `Antes da change:\n${item.proof.before}`].filter(Boolean);
  const name = item.kind === "tasks-pendentes" ? `Tasks pendentes: ${(item.pendingTasks ?? []).join(", ")}` : (item.scenario?.name ?? item.id);
  return (
    <li className={`verification-item result-${item.result}`}>
      <div className="verification-item-head">
        <strong>{name}</strong>
        {item.kind === "cenario" && <span className="badge">{resultLabel(item)}</span>}
        {proof && <span className="badge">{proof}</span>}
      </div>
      {item.evidence && (
        <p className="muted">
          <code>
            {item.evidence.member}/{item.evidence.file}:{item.evidence.line}
          </code>{" "}
          “{item.evidence.name}”
        </p>
      )}
      {item.reason && <p className="muted">{item.reason}</p>}
      {item.note && <p className="muted">Agente: {item.note}</p>}
      {item.checked?.note && <p className="muted">Conferido: {item.checked.note}</p>}
      {item.justification && <p className="muted">Justificativa: {item.justification}</p>}
      {outputs.length > 0 && (
        <details>
          <summary>Saída</summary>
          <pre className="git-output">{outputs.join("\n\n")}</pre>
        </details>
      )}
      <div className="actions">
        {item.result === "coberto" && canProve && item.proof?.status !== "rodando" && (
          <button type="button" className="secondary" disabled={busy} onClick={() => actions.prove(item.id)}>
            Provar
          </button>
        )}
        {item.result === "manual" && !item.checked && (
          <button type="button" className="secondary" disabled={busy} onClick={() => actions.check(item.id)}>
            Conferido
          </button>
        )}
        {item.result === "manual" && item.checked && (
          <button type="button" className="secondary" disabled={busy} onClick={() => actions.uncheck(item.id)}>
            Desfazer conferência
          </button>
        )}
        {(item.result === "sem-teste" || item.result === "evidencia-invalida") && (
          <button type="button" className="secondary" disabled={busy} onClick={() => actions.testTask(item.id)}>
            Gerar task de teste
          </button>
        )}
        {concern && <Justify item={item} busy={busy} onSave={(text) => actions.justify(item.id, text)} />}
      </div>
    </li>
  );
}

/** "Arquivar e commitar": the suggested message, and the Git failure of the commit, if any. */
function ArchiveCommitDialog({
  change,
  busy,
  error,
  onCommit,
  onCancel,
}: {
  change: string;
  busy: boolean;
  error?: ArchiveError | undefined;
  onCommit: (message: string, noVerify: boolean) => void;
  onCancel: () => void;
}) {
  const [message, setMessage] = useState(`archive: ${change}`);
  return (
    <form
      className="commit-dialog"
      aria-label="Arquivar e commitar"
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(message, false);
      }}
    >
      <label>
        Mensagem do commit
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
      </label>
      <p className="muted">O commit leva só os arquivos que o archive moveu ou alterou.</p>
      {error?.archived && <p className="muted">A change já foi arquivada; falta só o commit.</p>}
      {error && (error.git ? (
        <GitFailure error={error} busy={busy} onRetry={() => onCommit(message, false)} onNoVerify={() => onCommit(message, true)} />
      ) : (
        <p className="banner banner-error" role="alert">
          {error.message}
        </p>
      ))}
      <div className="actions">
        <button type="submit" disabled={busy || !message.trim()}>
          Commitar
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

/**
 * The verification of a change and its archive (spec: change-verification): the report by
 * capability and requirement, the actions on each item, and the archive behind the gate.
 */
export function VerificationPanel({
  change,
  state,
  busy,
  error,
  archiveError,
  committing,
  onCommitDialog,
  actions,
}: {
  change: string;
  state: VerificationState;
  busy: boolean;
  /** A verification action the backend refused. */
  error?: string | undefined;
  archiveError?: ArchiveError | undefined;
  /** The "Arquivar e commitar" dialog is open. */
  committing: boolean;
  onCommitDialog: (open: boolean) => void;
  actions: VerificationActions;
}) {
  const [confirming, setConfirming] = useState(false);
  const shown = state.running ?? state.report;
  const pending = state.report?.items.find((i) => i.kind === "tasks-pendentes")?.pendingTasks ?? [];
  const groups = new Map<string, Map<string, VerificationItem[]>>();
  for (const item of shown?.items ?? []) {
    if (item.kind !== "cenario" || !item.scenario) continue;
    const cap = groups.get(item.scenario.capability) ?? new Map<string, VerificationItem[]>();
    groups.set(item.scenario.capability, cap);
    cap.set(item.scenario.requirement, [...(cap.get(item.scenario.requirement) ?? []), item]);
  }
  const extra = (shown?.items ?? []).filter((i) => i.kind === "tasks-pendentes");
  const itemBusy = busy || !!state.running;
  const canProve = !state.proofUnavailable && !state.stale;
  const gate = state.archive;

  return (
    <section className="verification" aria-label="Verificação">
      <header className="verification-header">
        <h2>Verificação</h2>
        <div className="actions">
          {state.running ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => actions.stop()}>
              Parar verificação
            </button>
          ) : (
            <button type="button" disabled={busy || !state.canStart} onClick={() => actions.run()}>
              Verificar change
            </button>
          )}
        </div>
      </header>
      {!state.running && !state.canStart && state.startReason && <p className="muted">{state.startReason}</p>}
      {state.running && <p className="muted">Verificando…</p>}
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      {state.lastError && (
        <p className="banner banner-error" role="alert">
          {state.lastError}
        </p>
      )}
      {state.report && !state.running && (
        <p className={`verdict verdict-${state.report.verdict?.toLowerCase()}`}>
          <strong>Veredito: {state.report.verdict}</strong>
          {state.stale && <span className="banner banner-warn">Relatório desatualizado</span>}
        </p>
      )}
      {!state.report && !state.running && <p className="muted">A change ainda não foi verificada.</p>}
      {shown && state.proofUnavailable && <p className="muted">Prova vermelho → verde indisponível: {state.proofUnavailable}</p>}
      {shown && shown.items.length === 0 && !state.running && <p className="muted">A change não tem cenários a verificar.</p>}
      {[...groups].map(([cap, reqs]) => (
        <div key={cap} className="verification-capability">
          <h3>{cap}</h3>
          {[...reqs].map(([req, items]) => (
            <div key={req}>
              <h4>{req}</h4>
              <ul className="verification-items">
                {items.map((item) => (
                  <Item key={item.id} item={item} busy={itemBusy} canProve={canProve} actions={actions} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
      {extra.length > 0 && (
        <ul className="verification-items">
          {extra.map((item) => (
            <Item key={item.id} item={item} busy={itemBusy} canProve={false} actions={actions} />
          ))}
        </ul>
      )}

      <div className="verification-archive">
        <div className="actions">
          <button type="button" disabled={busy || !gate.allowed} onClick={() => setConfirming(true)}>
            Arquivar
          </button>
          {gate.git && (
            <button type="button" className="secondary" disabled={busy || !gate.allowed} onClick={() => onCommitDialog(true)}>
              Arquivar e commitar
            </button>
          )}
        </div>
        {!gate.allowed && gate.reason && <p className="muted">{gate.reason}</p>}
        {gate.missing.length > 0 && (
          <p className="muted">
            Falta justificar:{" "}
            {gate.missing.map((id) => shown?.items.find((i) => i.id === id)?.scenario?.name ?? (id === "tasks-pendentes" ? "tasks pendentes" : id)).join(", ")}
          </p>
        )}
        {archiveError && !committing && (
          <p className="banner banner-error" role="alert">
            {archiveError.message}
          </p>
        )}
        {confirming && (
          <div className="banner banner-warn" role="alertdialog" aria-label="Confirmar archive">
            <p>
              A change vai para <code>openspec/changes/archive/</code>, e as delta specs são aplicadas nas specs principais.
            </p>
            {pending.length > 0 && <p>Tasks ainda pendentes: {pending.join(", ")}.</p>}
            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  actions.archive();
                }}
              >
                Confirmar archive
              </button>
              <button type="button" className="secondary" onClick={() => setConfirming(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
        {committing && (
          <ArchiveCommitDialog
            change={change}
            busy={busy}
            error={archiveError}
            onCommit={actions.archiveCommit}
            onCancel={() => onCommitDialog(false)}
          />
        )}
      </div>
    </section>
  );
}
