import type { MemberIssue, RegisterWorkspaceInput, RegisterWorkspaceResult, StoreSetupResult } from "@studio/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../api.ts";

type Mode = "mono" | "multi";

export function NewWorkspacePage() {
  const [mode, setMode] = useState<Mode>("mono");
  const [path, setPath] = useState("");
  const [storeId, setStoreId] = useState("");
  const [members, setMembers] = useState("");
  const [newStore, setNewStore] = useState(false);
  const [storePath, setStorePath] = useState("");
  const [initGit, setInitGit] = useState(true);
  const [result, setResult] = useState<RegisterWorkspaceResult | undefined>();
  const [, navigate] = useLocation();
  const client = useQueryClient();

  const register = useMutation({
    mutationFn: async () => {
      if (mode === "multi" && newStore) {
        await api<StoreSetupResult>("/stores", { method: "POST", body: { id: storeId, path: storePath, initGit } });
      }
      const body: RegisterWorkspaceInput =
        mode === "mono"
          ? { kind: "mono", path }
          : { kind: "multi", storeId, members: members.split("\n").map((m) => m.trim()).filter(Boolean) };
      return api<RegisterWorkspaceResult>("/workspaces", { method: "POST", body });
    },
    onSuccess: (res) => {
      void client.invalidateQueries({ queryKey: ["workspaces"] });
      if (res.issues.length === 0) navigate(`/w/${res.workspace.id}`);
      else setResult(res);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    register.mutate();
  };

  if (result) return <MemberIssues result={result} />;

  return (
    <main>
      <header className="page-header">
        <h1>Novo workspace</h1>
      </header>
      <form onSubmit={submit} className="form">
        <fieldset className="segmented">
          <label>
            <input type="radio" checked={mode === "mono"} onChange={() => setMode("mono")} /> Mono-repo
          </label>
          <label>
            <input type="radio" checked={mode === "multi"} onChange={() => setMode("multi")} /> Multi-repo (store)
          </label>
        </fieldset>

        {mode === "mono" ? (
          <label>
            Pasta do projeto
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/voce/code/meu-app" required />
          </label>
        ) : (
          <>
            <label>
              Id do store
              <input value={storeId} onChange={(e) => setStoreId(e.target.value)} placeholder="specs-store" required />
            </label>
            <label className="inline">
              <input type="checkbox" checked={newStore} onChange={(e) => setNewStore(e.target.checked)} /> Criar novo
              store
            </label>
            {newStore && (
              <>
                <label>
                  Pasta do novo store
                  <input
                    value={storePath}
                    onChange={(e) => setStorePath(e.target.value)}
                    placeholder="/home/voce/openspec/specs-store"
                    required
                  />
                </label>
                <label className="inline">
                  <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} /> Iniciar
                  repositório Git com commit inicial
                </label>
              </>
            )}
            <label>
              Repositórios de código (um caminho por linha)
              <textarea value={members} onChange={(e) => setMembers(e.target.value)} rows={4} required />
            </label>
          </>
        )}

        {register.isError && (
          <p className="banner banner-error" role="alert">
            {register.error.message}
          </p>
        )}
        <div className="actions">
          <Link href="/">Cancelar</Link>
          <button type="submit" disabled={register.isPending}>
            {register.isPending ? "Registrando…" : "Registrar"}
          </button>
        </div>
      </form>
    </main>
  );
}

/** Offers to write `store:` into members that do not declare the workspace store. */
function MemberIssues({ result }: { result: RegisterWorkspaceResult }) {
  const [issues, setIssues] = useState<MemberIssue[]>(result.issues);
  const id = result.workspace.id;
  const declare = useMutation({
    mutationFn: (member: string) =>
      api<void>(`/workspaces/${id}/members/${encodeURIComponent(member)}/declare-store`, { method: "POST" }),
    onSuccess: (_, member) => setIssues((list) => list.filter((i) => i.member !== member)),
  });
  return (
    <main>
      <h1>Workspace registrado</h1>
      {issues.length > 0 ? (
        <>
          <p>Alguns membros não apontam para o store {result.workspace.storeId}:</p>
          <ul className="cards">
            {issues.map((issue) => (
              <li key={issue.member} className="card">
                <span>{issue.message}</span>
                <button type="button" disabled={declare.isPending} onClick={() => declare.mutate(issue.member)}>
                  Gravar <code>store: {result.workspace.storeId}</code> em {issue.member}
                </button>
              </li>
            ))}
          </ul>
          {declare.isError && <p className="banner banner-error">{declare.error.message}</p>}
        </>
      ) : (
        <p>Todos os membros apontam para o store.</p>
      )}
      <Link href={`/w/${id}`} className="button">
        Abrir workspace
      </Link>
    </main>
  );
}
