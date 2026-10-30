import type { ApplyState, ApplyTask, ApplyTaskStatus, MemberWarning, PermissionRequest } from "@studio/shared";
import { useState } from "react";
import { AgentStream } from "./AgentStream.tsx";
import { CommitDialog, type GitError } from "./GitPanel.tsx";

const STATUS_LABEL: Record<ApplyTaskStatus, string> = {
  pendente: "pendente",
  "na-fila": "na fila",
  rodando: "rodando",
  "aguardando-permissao": "aguardando permissão",
  "aguardando-revisao": "aguardando revisão",
  aceita: "aceita",
  incompleta: "incompleta",
};

const WARNING_TEXT: Record<MemberWarning["kind"], (member: string) => string> = {
  "sem-git": (m) => `${m} não é um repositório Git: as alterações nele não poderão ser desfeitas.`,
  "alteracoes-pendentes": (m) =>
    `${m} tem alterações não commitadas. Elas ficam fora do diff das tasks e são preservadas ao desfazer.`,
};

export interface ApplyActions {
  run: (mode: "proxima" | "todas") => void;
  confirm: () => void;
  dismiss: () => void;
  stop: () => void;
  accept: (task: string) => void;
  undo: (task: string) => void;
  adjust: (task: string, request: string) => void;
  reply: (requestId: string, reply: "once" | "always" | "reject") => void;
  /** "Aceitar e commitar" (add-git-commits). */
  commit: (task: string, message: string, noVerify: boolean) => void;
  /** Opens the action that resolves a warning: init for "sem-git", commit for "alteracoes-pendentes". */
  resolveWarning?: (warning: MemberWarning) => void;
  /** Sets the identity of the repos that have none, after a commit failed for lack of it. */
  setIdentity?: (name: string, email: string) => Promise<unknown>;
}

const RESOLVE_LABEL: Record<MemberWarning["kind"], string> = {
  "sem-git": "Inicializar Git",
  "alteracoes-pendentes": "Commitar pendências",
};

/** Runs and reviews a change's tasks (spec: change-apply). */
export function ApplyPanel({
  state,
  warnings,
  busy,
  actions,
  commitError,
}: {
  state: ApplyState;
  /** Member warnings waiting for confirmation before a run. */
  warnings?: MemberWarning[] | undefined;
  busy: boolean;
  actions: ApplyActions;
  /** The last "Aceitar e commitar" failure, shown in the review it came from. */
  commitError?: (GitError & { task: string }) | undefined;
}) {
  const [open, setOpen] = useState<string | undefined>();
  const pending = state.tasks.some((t) => t.status === "pendente");
  const reviewable = state.tasks.filter((t) => t.status === "aguardando-revisao" || t.status === "incompleta");
  const selected = state.tasks.find((t) => t.id === open) ?? reviewable.at(-1);

  return (
    <section className="apply" aria-label="Apply">
      <div className="section-head">
        <h2>Tasks</h2>
        <div className="actions">
          {state.running ? (
            <button type="button" className="danger" onClick={() => actions.stop()}>
              Parar
            </button>
          ) : (
            <>
              <button type="button" disabled={!state.hasTasks || !pending || busy} onClick={() => actions.run("proxima")}>
                Executar próxima
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!state.hasTasks || !pending || busy}
                onClick={() => actions.run("todas")}
              >
                Executar todas
              </button>
            </>
          )}
        </div>
      </div>

      {!state.hasTasks && <p className="empty">Gere as tasks da change antes de executar.</p>}
      {state.running && (
        <p className="muted">Evite editar os arquivos do workspace enquanto uma task roda: a edição entraria no diff dela.</p>
      )}

      {warnings && warnings.length > 0 && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Avisos antes de executar">
          <ul>
            {warnings.map((w) => (
              <li key={`${w.member}-${w.kind}`}>
                {WARNING_TEXT[w.kind](w.member)}{" "}
                {actions.resolveWarning && (
                  <button type="button" className="link" onClick={() => actions.resolveWarning!(w)}>
                    {RESOLVE_LABEL[w.kind]}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" onClick={() => actions.confirm()}>
              Continuar mesmo assim
            </button>
            <button type="button" className="secondary" onClick={() => actions.dismiss()}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {state.permission && <PermissionDialog request={state.permission} onReply={(r) => actions.reply(state.permission!.requestId, r)} />}
      {state.run && (state.running || state.run.status !== "concluido") && <AgentStream run={state.run} />}

      <ul className="apply-tasks">
        {state.tasks.map((t) => (
          <li key={t.id} className={`task apply-task-${t.status}${t.status === "aceita" ? " task-done" : ""}`}>
            <span className="check" aria-label={t.status === "aceita" ? "concluída" : "pendente"}>
              {t.status === "aceita" ? "✓" : "○"}
            </span>
            <span className="task-id">{t.id}</span> {t.text}{" "}
            <span className={`status status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
            {(t.status === "aguardando-revisao" || t.status === "incompleta") && (
              <button type="button" className="link" onClick={() => setOpen(t.id)}>
                Revisar
              </button>
            )}
          </li>
        ))}
      </ul>

      {selected && (selected.status === "aguardando-revisao" || selected.status === "incompleta") && (
        <TaskReview
          key={selected.id}
          task={selected}
          busy={busy || state.running}
          actions={actions}
          commitError={commitError?.task === selected.id ? commitError : undefined}
        />
      )}
    </section>
  );
}

/** The result of one task: the agent's summary, the diff by member, and the review actions. */
export function TaskReview({
  task,
  busy,
  actions,
  commitError,
}: {
  task: ApplyTask;
  busy: boolean;
  actions: ApplyActions;
  commitError?: GitError | undefined;
}) {
  const [request, setRequest] = useState("");
  const [committing, setCommitting] = useState(Boolean(commitError));
  const withoutGit = (task.diff ?? []).filter((d) => !d.git).map((d) => d.member);
  const dirty = (task.diff ?? []).flatMap((d) => (d.dirtyBefore ?? []).map((path) => `${d.member}/${path}`));
  return (
    <article className="task-review" aria-label={`Revisão da task ${task.id}`}>
      <h3>
        Revisão da task {task.id}
      </h3>
      {task.error && (
        <p className="banner banner-error" role="alert">
          {task.error}
        </p>
      )}
      {task.summary && <p className="lead">{task.summary}</p>}
      {(task.diff ?? []).length === 0 && <p className="empty">A task não alterou arquivos.</p>}
      {(task.diff ?? []).map((d) => (
        <section key={d.member} className="member-diff">
          <h4>{d.member}</h4>
          {d.git ? (
            d.files.map((f) => (
              <details key={f.path}>
                <summary>
                  <code>{f.path}</code> <span className={`change change-${f.change}`}>{f.change}</span>
                </summary>
                <pre className="diff">{f.patch}</pre>
              </details>
            ))
          ) : (
            <ul>
              {(d.written ?? []).map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {withoutGit.length > 0 && (
        <p className="muted">Sem Git em {withoutGit.join(", ")}: as alterações nesses membros não são desfeitas.</p>
      )}
      {dirty.length > 0 && (
        <div className="banner banner-warn" role="note">
          Estes arquivos já tinham alterações não commitadas antes da task, e um commit levaria também essas alterações:{" "}
          {dirty.map((p) => (
            <code key={p}>{p} </code>
          ))}
          . Aceite sem commit, ou commite as pendências pelo terminal e depois commite a task.
        </div>
      )}
      {committing && task.commit && (
        <CommitDialog
          message={task.commit.message}
          repos={task.commit.repos}
          done={task.commit.done}
          busy={busy}
          error={commitError}
          onCommit={(message, noVerify) => actions.commit(task.id, message, noVerify)}
          onCancel={() => setCommitting(false)}
          onIdentity={actions.setIdentity}
        />
      )}
      {task.commit && !task.commit.allowed && task.commit.reason && dirty.length === 0 && (
        <p className="muted">Aceitar e commitar: {task.commit.reason}.</p>
      )}
      <div className="actions">
        {task.status === "aguardando-revisao" && (
          <button type="button" disabled={busy} onClick={() => actions.accept(task.id)}>
            Aceitar
          </button>
        )}
        {task.status === "aguardando-revisao" && task.commit && dirty.length === 0 && !committing && (
          <button
            type="button"
            className="secondary"
            disabled={busy || !task.commit.allowed}
            title={task.commit.reason}
            onClick={() => setCommitting(true)}
          >
            Aceitar e commitar
          </button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={busy || !task.canUndo}
          title={task.canUndo ? undefined : "Desfaça antes a task mais recente"}
          onClick={() => actions.undo(task.id)}
        >
          Desfazer
        </button>
      </div>
      <form
        className="adjust"
        onSubmit={(e) => {
          e.preventDefault();
          actions.adjust(task.id, request);
          setRequest("");
        }}
      >
        <label>
          Pedir ajuste
          <textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={2} />
        </label>
        <button type="submit" className="secondary" disabled={busy || request.trim().length < 3 || !task.canUndo}>
          Ajustar
        </button>
      </form>
    </article>
  );
}

/** Asks the user about a command outside the allowed list (spec: "Perguntar antes de comando não liberado"). */
export function PermissionDialog({
  request,
  onReply,
}: {
  request: PermissionRequest;
  onReply: (reply: "once" | "always" | "reject") => void;
}) {
  const command = request.patterns.join(" && ");
  return (
    <div className="banner banner-warn permission" role="alertdialog" aria-label="Pedido de permissão">
      <p>
        {request.permission === "bash" ? "O agente quer executar:" : `O agente pede permissão (${request.permission}):`}{" "}
        <code>{command}</code>
      </p>
      <div className="actions">
        <button type="button" onClick={() => onReply("once")}>
          Permitir uma vez
        </button>
        {request.permission === "bash" && (
          <button type="button" className="secondary" onClick={() => onReply("always")}>
            Sempre neste workspace
          </button>
        )}
        <button type="button" className="danger" onClick={() => onReply("reject")}>
          Recusar
        </button>
      </div>
    </div>
  );
}

/** Edits the commands the agent may run without asking (add-visual-apply D8). */
export function CommandListEditor({ commands, onSave, saving }: { commands: string[]; onSave: (c: string[]) => void; saving: boolean }) {
  const [text, setText] = useState(commands.join("\n"));
  return (
    <form
      className="command-list"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(text.split("\n"));
      }}
    >
      <label>
        Comandos liberados para o apply (um por linha)
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.max(3, commands.length + 1)} />
      </label>
      <p className="muted">
        O agente roda estes comandos sem perguntar. Qualquer outro é perguntado. Mudanças valem a partir da próxima sessão de
        apply.
      </p>
      <button type="submit" className="secondary" disabled={saving}>
        Salvar comandos
      </button>
    </form>
  );
}
