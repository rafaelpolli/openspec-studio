import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../api.ts";
import { CommandListEditor } from "../components/ApplyPanel.tsx";
import { EnvironmentChooser } from "../components/EnvironmentPanel.tsx";
import { GitDialogHost, type GitDialog } from "../components/GitDialogHost.tsx";
import { GitSection } from "../components/GitPanel.tsx";
import { ChangeList } from "../components/ChangeList.tsx";
import { ExplorationList } from "../components/ExplorationList.tsx";
import { SpecList } from "../components/SpecList.tsx";
import { KindBadge, TypeBadge } from "../components/TypeBadge.tsx";
import { ValidationPanel } from "../components/ValidationPanel.tsx";
import {
  useApplyCommands,
  useChanges,
  useCreateExploration,
  useExplorations,
  useEnvironmentActions,
  useEnvironmentSettings,
  useGit,
  useGitActions,
  useSaveApplyCommands,
  useSpecs,
  useValidate,
  useWorkspace,
} from "../queries.ts";
import { QueryState } from "./QueryState.tsx";

export function WorkspacePage({ id }: { id: string }) {
  const workspace = useWorkspace(id);
  const hasOpenSpec = workspace.data?.hasOpenSpec ?? false;
  const specs = useSpecs(id, hasOpenSpec);
  const changes = useChanges(id, hasOpenSpec);
  const validate = useValidate(id);
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api<void>(`/workspaces/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["workspaces"] });
      navigate("/");
    },
  });

  return (
    <main>
      <QueryState query={workspace}>
        {(ws) => (
          <>
            <header className="page-header">
              <div>
                <Link href="/" className="muted">
                  ← workspaces
                </Link>
                <h1>{ws.name}</h1>
                <div className="badges">
                  <KindBadge kind={ws.kind} />
                  <TypeBadge type={ws.projectType} />
                </div>
              </div>
              <div className="actions">
                <button type="button" onClick={() => validate.mutate(undefined)} disabled={validate.isPending}>
                  Validar tudo
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (confirm(`Remover "${ws.name}" da aplicação? Nenhum arquivo será apagado.`)) remove.mutate();
                  }}
                >
                  Remover
                </button>
              </div>
            </header>
            {validate.data && <ValidationPanel report={validate.data} />}
            {validate.isError && <p className="banner banner-error">{validate.error.message}</p>}
            {(ws.needsInit || ws.projectType === "brownfield") && (
              <div className="banner banner-info">
                {ws.needsInit
                  ? "Este workspace ainda não foi inicializado para o OpenSpec com o OpenCode."
                  : "Há código sem specs neste workspace: gere specs de baseline a partir dele."}{" "}
                <Link href={`/w/${id}/onboarding`} className="button">
                  {ws.needsInit ? "Inicializar" : "Onboarding brownfield"}
                </Link>
              </div>
            )}
            {!ws.hasOpenSpec ? (
              <p className="empty">Este workspace ainda não tem OpenSpec.</p>
            ) : (
              <div className="columns">
                <section>
                  <div className="section-head">
                    <h2>Changes</h2>
                    <Link href={`/w/${id}/changes/new`} className="button">
                      Nova change
                    </Link>
                  </div>
                  <QueryState query={changes}>{(list) => <ChangeList workspaceId={id} changes={list} />}</QueryState>
                </section>
                <section>
                  <h2>Specs</h2>
                  <QueryState query={specs}>{(list) => <SpecList workspaceId={id} specs={list} />}</QueryState>
                </section>
              </div>
            )}
            {ws.hasOpenSpec && <Explorations id={id} />}
            <GitSettings id={id} />
            {ws.hasOpenSpec && <ApplyCommands id={id} />}
          </>
        )}
      </QueryState>
    </main>
  );
}

/** The Git of each member and of the store (spec: git-repositories). */
/** The explorations section, wired to the backend; a new one opens right away. */
function Explorations({ id }: { id: string }) {
  const explorations = useExplorations(id);
  const create = useCreateExploration(id);
  const [, navigate] = useLocation();
  return (
    <QueryState query={explorations}>
      {(list) => (
        <ExplorationList
          workspaceId={id}
          explorations={list}
          creating={create.isPending}
          onCreate={() => create.mutate(undefined, { onSuccess: (e) => navigate(`/w/${id}/explorations/${e.id}`) })}
        />
      )}
    </QueryState>
  );
}

function GitSettings({ id }: { id: string }) {
  const git = useGit(id);
  const actions = useGitActions(id);
  const [dialog, setDialog] = useState<GitDialog | undefined>();
  const busy = actions.setIdentity.isPending || actions.clearIdentity.isPending;
  const error = actions.setIdentity.error ?? actions.clearIdentity.error;
  return (
    <QueryState query={git}>
      {(state) => (
        <>
          <GitSection
            state={state}
            busy={busy}
            actions={{
              setIdentity: (area, name, email) => actions.setIdentity.mutate({ area: area.path, name, email }),
              clearIdentity: (area) => actions.clearIdentity.mutate(area.path),
              open: (area, kind) => setDialog({ area, kind }),
            }}
          />
          {error && <p className="banner banner-error">{error.message}</p>}
          {dialog && <GitDialogHost key={`${dialog.area.path}:${dialog.kind}`} id={id} dialog={dialog} onClose={() => setDialog(undefined)} />}
        </>
      )}
    </QueryState>
  );
}

/** The workspace's allowed apply commands (spec: change-apply, "Comandos permitidos"). */
function ApplyCommands({ id }: { id: string }) {
  const commands = useApplyCommands(id);
  const save = useSaveApplyCommands(id);
  const environment = useEnvironmentSettings(id);
  const env = useEnvironmentActions(id);
  return (
    <details className="settings">
      <summary>Configurações do apply</summary>
      <QueryState query={environment}>
        {(settings) => (
          <EnvironmentChooser
            key={`${settings.config.mode}:${settings.config.idleMinutes}`}
            settings={settings}
            saving={env.save.isPending}
            onSave={(config) => env.save.mutate(config)}
          />
        )}
      </QueryState>
      {env.save.isError && <p className="banner banner-error">{env.save.error.message}</p>}
      <QueryState query={commands}>
        {(data) => (
          <CommandListEditor
            key={data.commands.join("\n")}
            commands={data.commands}
            saving={save.isPending}
            onSave={(list) => save.mutate(list)}
          />
        )}
      </QueryState>
      {save.isError && <p className="banner banner-error">{save.error.message}</p>}
    </details>
  );
}
