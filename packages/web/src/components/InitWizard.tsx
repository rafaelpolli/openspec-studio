import type { WorkspaceView } from "@studio/shared";
import { useState } from "react";

const LANGUAGES = [
  { tag: "pt-BR", label: "Português (Brasil)" },
  { tag: "en", label: "English" },
  { tag: "es", label: "Español" },
];

/** Initializes OpenSpec with the OpenCode commands and the artifact language (task 8.1). */
export function InitWizard({
  workspace,
  onInit,
  pending,
  error,
}: {
  workspace: WorkspaceView;
  onInit: (language: string) => void;
  pending?: boolean;
  error?: string | undefined;
}) {
  const [choice, setChoice] = useState("pt-BR");
  const [other, setOther] = useState("");
  const language = choice === "outro" ? other.trim() : choice;
  return (
    <form
      className="form"
      aria-label="Inicializar OpenSpec"
      onSubmit={(e) => {
        e.preventDefault();
        if (language) onInit(language);
      }}
    >
      <p>
        {workspace.kind === "mono" ? (
          <>
            Cria <code>openspec/</code> e os comandos do OpenCode em <code>{workspace.rootPath}</code>.
          </>
        ) : (
          <>
            Configura os comandos do OpenCode e o idioma no store <code>{workspace.storeId}</code>. Os repositórios
            membros não são alterados.
          </>
        )}
      </p>
      <label>
        Idioma dos artefatos
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          {LANGUAGES.map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.label}
            </option>
          ))}
          <option value="outro">Outro…</option>
        </select>
      </label>
      {choice === "outro" && (
        <label>
          Código do idioma
          <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="ex.: fr, de-AT" />
        </label>
      )}
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={pending || !language}>
          {pending ? "Inicializando…" : "Inicializar"}
        </button>
      </div>
    </form>
  );
}
