import type { EnvironmentConfig, EnvironmentMode, EnvironmentSettings, EnvironmentState, EnvironmentStatus } from "@studio/shared";
import { useState } from "react";

/** Chooses where the workspace's apply runs (spec: apply-environment, "Escolher o ambiente do apply"). */
export function EnvironmentChooser({
  settings,
  saving,
  onSave,
}: {
  settings: EnvironmentSettings;
  saving: boolean;
  onSave: (config: EnvironmentConfig) => void;
}) {
  const [mode, setMode] = useState<EnvironmentMode>(settings.config.mode);
  const [idle, setIdle] = useState(String(settings.config.idleMinutes));
  const options: { mode: EnvironmentMode; label: string }[] = [
    ...settings.devcontainers.map((d) => ({ mode: `devcontainer:${d.path}` as EnvironmentMode, label: `Usar o devcontainer de ${d.member}` })),
    ...settings.images.map((i) => ({ mode: `imagem:${i.id}` as EnvironmentMode, label: `Imagem padrão: ${i.label}` })),
    { mode: "local", label: "Sem container (na máquina)" },
  ];
  const minutes = Number(idle);
  return (
    <form
      className="environment-chooser"
      aria-label="Ambiente do apply"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ mode, idleMinutes: minutes });
      }}
    >
      <fieldset>
        <legend>Onde o apply roda</legend>
        {options.map((o) => (
          <label key={o.mode} className="radio">
            <input type="radio" name="environment" checked={mode === o.mode} onChange={() => setMode(o.mode)} />
            {o.label}
            {settings.suggested === o.mode && <span className="badge"> sugerida</span>}
          </label>
        ))}
      </fieldset>
      {settings.devcontainers.length === 0 && (
        <p className="muted">Nenhum membro tem .devcontainer/devcontainer.json: escolha uma imagem padrão ou rode sem container.</p>
      )}
      <label>
        Parar o container depois de (minutos sem tasks)
        <input type="number" min={1} value={idle} onChange={(e) => setIdle(e.target.value)} disabled={mode === "local"} />
      </label>
      <p className="muted">Cada workspace tem o próprio container: versões, pacotes globais, portas e serviços não se misturam.</p>
      <button type="submit" className="secondary" disabled={saving || !Number.isInteger(minutes) || minutes < 1}>
        Salvar ambiente
      </button>
    </form>
  );
}

const STATE_LABEL: Record<EnvironmentState, string> = {
  ausente: "Container ainda não preparado: ele sobe na primeira task.",
  preparando: "Preparando o container…",
  pronto: "Container pronto.",
  parado: "Container parado: ele volta a subir na próxima task.",
  falhou: "O ambiente não pôde ser preparado.",
};

/** The state of the apply container in the apply panel (spec: "Ciclo de vida do ambiente", "Falha do ambiente"). */
export function EnvironmentStatusBox({
  status,
  busy,
  onStop,
  onRebuild,
  onUseLocal,
}: {
  status: EnvironmentStatus;
  busy: boolean;
  onStop: () => void;
  onRebuild: () => void;
  onUseLocal: () => void;
}) {
  if (status.mode === "local") return null;
  const where = status.mode.startsWith("devcontainer:") ? "devcontainer do projeto" : `imagem ${status.mode.slice("imagem:".length)}`;
  return (
    <section className={`environment environment-${status.state}`} aria-label="Ambiente do apply">
      <p role="status">
        <strong>{STATE_LABEL[status.state]}</strong> <span className="muted">({where})</span>
      </p>
      {status.state === "falhou" && (
        <div className="banner banner-error" role="alert">
          <p>{status.error}</p>
          <button type="button" className="secondary" onClick={onUseLocal}>
            Rodar sem container
          </button>
        </div>
      )}
      {status.needsRebuild && (
        <p className="banner banner-warn">O devcontainer.json mudou desde o preparo. Reconstrua o ambiente para usar a nova configuração.</p>
      )}
      {status.uidMismatch && (
        <p className="banner banner-warn">
          O usuário do container não ficou com o seu UID: os arquivos que o agente criar podem pertencer a outro usuário.
        </p>
      )}
      {(status.state === "preparando" || status.state === "falhou") && status.output.length > 0 && (
        <pre className="environment-output" aria-label="Saída do preparo">
          {status.output.slice(-40).join("\n")}
        </pre>
      )}
      <div className="actions">
        {status.state === "pronto" && (
          <button type="button" className="secondary" disabled={busy} onClick={onStop}>
            Parar ambiente
          </button>
        )}
        {status.state !== "preparando" && status.state !== "ausente" && (
          <button type="button" className="secondary" disabled={busy} onClick={onRebuild}>
            Reconstruir ambiente
          </button>
        )}
      </div>
    </section>
  );
}
