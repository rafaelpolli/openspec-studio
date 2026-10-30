import type { GitArea, GitIdentity, GitState, InitPreview } from "@studio/shared";
import { useEffect, useRef, useState } from "react";
import type { GitFailureDetail } from "../api.ts";

/** A failed Git action, as the dialogs receive it. */
export interface GitError {
  message: string;
  git?: GitFailureDetail | undefined;
}

const SCOPE_LABEL: Record<string, string> = { local: "do repo", global: "global", system: "do sistema" };

function identityText(identity: GitIdentity): string {
  if (!identity.name || !identity.email) return "sem identidade";
  const scope = identity.nameScope === identity.emailScope ? SCOPE_LABEL[identity.nameScope ?? ""] : "mista";
  return `${identity.name} <${identity.email}> (${scope ?? identity.nameScope})`;
}

/** Sets the repo's own `user.name`/`user.email` (spec: git-repositories, "Identidade do Git por repo"). */
export function IdentityForm({
  initial,
  saving,
  onSave,
  label = "Salvar identidade do repo",
}: {
  initial?: GitIdentity;
  saving: boolean;
  onSave: (name: string, email: string) => void;
  label?: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  // Not a <form>: it is also shown inside the commit dialogs, which are forms themselves.
  return (
    <div className="identity-form" role="group" aria-label="Identidade do Git">
      <label>
        Nome
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        E-mail
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={saving || !name.trim() || !email.includes("@")}
        onClick={() => onSave(name.trim(), email.trim())}
      >
        {label}
      </button>
    </div>
  );
}

/**
 * The failure of a commit, with what to do next: commit without hooks after a hook refused,
 * set the identity when Git does not know the author, or use the terminal for signing (D5).
 */
export function GitFailure({
  error,
  busy,
  onRetry,
  onNoVerify,
  onIdentity,
}: {
  error: GitError;
  busy: boolean;
  onRetry: () => void;
  onNoVerify: () => void;
  onIdentity?: ((name: string, email: string) => void) | undefined;
}) {
  const kind = error.git?.kind;
  // GitFailure only shows the form; the dialogs decide what saving it does.
  return (
    <div className="banner banner-error" role="alert">
      <p>{error.message}</p>
      {error.git?.output && (
        <pre className="git-output" aria-label="Saída do Git">
          {error.git.output}
        </pre>
      )}
      {kind === "identidade" && onIdentity && <IdentityForm saving={busy} onSave={onIdentity} label="Salvar identidade e tentar de novo" />}
      <div className="actions">
        {kind !== "assinatura" && (
          <button type="button" className="secondary" disabled={busy} onClick={onRetry}>
            Tentar de novo
          </button>
        )}
        {kind === "hook" && (
          <button type="button" className="danger" disabled={busy} onClick={onNoVerify}>
            Commitar sem hooks
          </button>
        )}
      </div>
    </div>
  );
}

/** "Aceitar e commitar": the suggested message, editable, and the repos that get a commit. */
export function CommitDialog({
  message: suggested,
  repos,
  done,
  busy,
  error,
  onCommit,
  onCancel,
  onIdentity,
}: {
  message: string;
  repos: string[];
  done: string[];
  busy: boolean;
  error?: GitError | undefined;
  onCommit: (message: string, noVerify: boolean) => void;
  onCancel: () => void;
  /** Saves the identity of the repos without one; the commit is then tried again. */
  onIdentity?: ((name: string, email: string) => Promise<unknown>) | undefined;
}) {
  const [message, setMessage] = useState(suggested);
  return (
    <form
      className="commit-dialog"
      aria-label="Aceitar e commitar"
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(message, false);
      }}
    >
      <label>
        Mensagem do commit
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
      </label>
      <p className="muted">
        Um commit em: {repos.join(", ")}.{done.length > 0 && ` Já commitado numa tentativa anterior: ${done.join(", ")}.`}
      </p>
      {error && (
        <GitFailure
          error={error}
          busy={busy}
          onRetry={() => onCommit(message, false)}
          onNoVerify={() => onCommit(message, true)}
          onIdentity={onIdentity && ((name, email) => void onIdentity(name, email).then(() => onCommit(message, false)))}
        />
      )}
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

/** "Commitar pendências" of one area (spec: git-repositories, "Commitar pendências"). */
export function PendingCommitDialog({
  area,
  busy,
  error,
  onCommit,
  onCancel,
  onIdentity,
}: {
  area: GitArea;
  busy: boolean;
  error?: GitError | undefined;
  onCommit: (message: string, noVerify: boolean) => void;
  onCancel: () => void;
  /** Saves the repo's identity; the commit is then tried again. */
  onIdentity?: ((name: string, email: string) => Promise<unknown>) | undefined;
}) {
  const [message, setMessage] = useState("");
  return (
    <form
      className="commit-dialog"
      aria-label={`Commitar pendências de ${area.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(message, false);
      }}
    >
      <p>
        {area.pending} {area.pending === 1 ? "arquivo alterado" : "arquivos alterados"} em <strong>{area.name}</strong> entram no
        commit.
      </p>
      <label>
        Mensagem do commit
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
      </label>
      {error && (
        <GitFailure
          error={error}
          busy={busy}
          onRetry={() => onCommit(message, false)}
          onNoVerify={() => onCommit(message, true)}
          onIdentity={onIdentity && ((name, email) => void onIdentity(name, email).then(() => onCommit(message, false)))}
        />
      )}
      <div className="actions">
        <button type="submit" disabled={busy || !message.trim()}>
          Commitar pendências
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * "Inicializar Git": the proposed `.gitignore`, editable, with the files of the initial
 * commit recomputed as it changes, and one action that always makes the initial commit
 * (spec: "Inicializar Git com commit inicial").
 */
export function InitDialog({
  area,
  busy,
  error,
  onPreview,
  onInit,
  onCancel,
  debounceMs = 400,
}: {
  area: GitArea;
  busy: boolean;
  error?: GitError | undefined;
  onPreview: (gitignore?: string) => Promise<InitPreview>;
  /** `identity` is set in the new repo before its initial commit, when Git did not know the author. */
  onInit: (gitignore: string, message: string, noVerify: boolean, identity?: { name: string; email: string }) => void;
  onCancel: () => void;
  debounceMs?: number;
}) {
  const [preview, setPreview] = useState<InitPreview | undefined>();
  const [gitignore, setGitignore] = useState<string | undefined>();
  const [message, setMessage] = useState("Estado inicial");
  const [previewError, setPreviewError] = useState<string | undefined>();

  // The text the shown preview was computed for: filling in the suggestion does not ask again.
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (gitignore !== undefined && gitignore === shown.current) return;
    let live = true;
    const timer = setTimeout(
      () => {
        onPreview(gitignore)
          .then((p) => {
            if (!live) return;
            setPreview(p);
            setPreviewError(undefined);
            shown.current = p.gitignore;
            if (gitignore === undefined) setGitignore(p.gitignore);
          })
          .catch((err: Error) => live && setPreviewError(err.message));
      },
      gitignore === undefined ? 0 : debounceMs,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // onPreview is a new function on every render of the parent; only the text matters.
  }, [gitignore]);

  const text = gitignore ?? "";
  return (
    <form
      className="init-dialog"
      aria-label={`Inicializar Git em ${area.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        onInit(text, message, false);
      }}
    >
      <h3>Inicializar Git em {area.name}</h3>
      <label>
        .gitignore
        <textarea value={text} onChange={(e) => setGitignore(e.target.value)} rows={8} />
      </label>
      {preview?.existing && <p className="muted">O .gitignore que já existe é mantido; só as linhas novas no fim são acrescentadas.</p>}
      {previewError && <p className="banner banner-error">{previewError}</p>}
      {preview && preview.secrets.length > 0 && (
        <ul className="secrets" aria-label="Arquivos que parecem conter segredos">
          {preview.secrets.map((s) => (
            <li key={s.path} className={s.ignored ? "secret-ignored" : "secret-included"}>
              <code>{s.path}</code> parece conter segredos: {s.ignored ? "fica fora do commit" : "vai entrar no commit!"}
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <details>
          <summary>
            Vão entrar no commit inicial: {preview.fileCount} {preview.fileCount === 1 ? "arquivo" : "arquivos"}, {kb(preview.totalBytes)}
          </summary>
          <ul className="init-files" aria-label="Arquivos do commit inicial">
            {preview.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code> <span className="muted">{kb(f.size)}</span>
              </li>
            ))}
            {preview.fileCount > preview.files.length && <li className="muted">… e mais {preview.fileCount - preview.files.length}</li>}
          </ul>
        </details>
      )}
      <label>
        Mensagem do commit inicial
        <input value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {error && (
        <GitFailure
          error={error}
          busy={busy}
          onRetry={() => onInit(text, message, false)}
          onNoVerify={() => onInit(text, message, true)}
          onIdentity={(name, email) => onInit(text, message, false, { name, email })}
        />
      )}
      <div className="actions">
        <button type="submit" disabled={busy || !preview || Boolean(previewError) || !message.trim()}>
          Inicializar e fazer commit inicial
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

export interface GitSectionActions {
  setIdentity: (area: GitArea, name: string, email: string) => void;
  clearIdentity: (area: GitArea) => void;
  open: (area: GitArea, dialog: "init" | "pending") => void;
}

/** The workspace's "Git" section: one row per area, with its state, identity and actions. */
export function GitSection({ state, busy, actions }: { state: GitState; busy: boolean; actions: GitSectionActions }) {
  const [editing, setEditing] = useState<string | undefined>();
  return (
    <section className="git-section" aria-label="Git">
      <h2>Git</h2>
      <ul className="git-areas">
        {state.areas.map((a) => (
          <li key={a.path} className="git-area">
            <div>
              <strong>{a.name}</strong>{" "}
              {a.git ? (
                <span className="muted">
                  {a.branch ?? "HEAD destacado"}
                  {a.nested ? " · parte de um repo maior" : ""} ·{" "}
                  {a.pending === 0 ? "limpo" : `${a.pending} ${a.pending === 1 ? "alteração pendente" : "alterações pendentes"}`}
                </span>
              ) : (
                <span className="status">sem Git</span>
              )}
            </div>
            <div className="muted" aria-label={`Identidade de ${a.name}`}>
              Autor: {identityText(a.identity)}
            </div>
            <div className="actions">
              {!a.git && (
                <button type="button" disabled={busy} onClick={() => actions.open(a, "init")}>
                  Inicializar Git
                </button>
              )}
              {a.git && a.pending > 0 && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || state.busy}
                  title={state.busy ? "Aceite ou desfaça a task em revisão antes" : undefined}
                  onClick={() => actions.open(a, "pending")}
                >
                  Commitar pendências
                </button>
              )}
              {a.git && (
                <button type="button" className="link" onClick={() => setEditing(editing === a.path ? undefined : a.path)}>
                  Identidade própria
                </button>
              )}
              {a.git && (a.identity.nameScope === "local" || a.identity.emailScope === "local") && (
                <button type="button" className="link" disabled={busy} onClick={() => actions.clearIdentity(a)}>
                  Remover identidade do repo
                </button>
              )}
            </div>
            {state.busy && a.git && a.pending > 0 && (
              <p className="muted">Há uma task rodando ou aguardando revisão: aceite ou desfaça a task antes de commitar as pendências.</p>
            )}
            {editing === a.path && (
              <IdentityForm
                initial={a.identity.nameScope === "local" ? a.identity : {}}
                saving={busy}
                onSave={(name, email) => {
                  actions.setIdentity(a, name, email);
                  setEditing(undefined);
                }}
              />
            )}
          </li>
        ))}
      </ul>
      <p className="muted">A identidade própria fica no repo (.git/config). A configuração global do Git não é alterada.</p>
    </section>
  );
}
