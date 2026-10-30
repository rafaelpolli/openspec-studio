import type { OauthStart, ProvidersResponse, ProviderView } from "@studio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { QueryState } from "./QueryState.tsx";

const KEY = ["providers"];

function useProviderMutation<T, R>(fn: (arg: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: KEY });
      void client.invalidateQueries({ queryKey: ["engine"] });
    },
  });
}

export function ProvidersPage() {
  const query = useQuery({ queryKey: KEY, queryFn: () => api<ProvidersResponse>("/providers") });
  const [filter, setFilter] = useState("");
  return (
    <main>
      <header className="page-header">
        <h1>Provedores de LLM</h1>
      </header>
      <p className="muted">
        As credenciais ficam só no diretório de dados da aplicação e nunca são exibidas depois de salvas.
      </p>
      <QueryState query={query}>
        {(data) => (
          <>
            <DefaultModel data={data} />
            <input
              className="search"
              placeholder="Filtrar provedores"
              aria-label="Filtrar provedores"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <ProviderList providers={data.providers} filter={filter} />
          </>
        )}
      </QueryState>
    </main>
  );
}

function ProviderList({ providers, filter }: { providers: ProviderView[]; filter: string }) {
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? providers.filter((p) => `${p.id} ${p.name}`.toLowerCase().includes(f)) : providers;
  }, [providers, filter]);
  return (
    <ul className="cards">
      {shown.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
    </ul>
  );
}

export function ProviderCard({ provider }: { provider: ProviderView }) {
  const [key, setKey] = useState("");
  const [oauth, setOauth] = useState<{ method: number; start: OauthStart } | undefined>();
  const [code, setCode] = useState("");
  const saveKey = useProviderMutation((value: string) =>
    api<void>(`/providers/${provider.id}/key`, { method: "PUT", body: { key: value } }),
  );
  const remove = useProviderMutation(() => api<{ applied: boolean }>(`/providers/${provider.id}`, { method: "DELETE" }));
  const startOauth = useMutation({
    mutationFn: (method: number) =>
      api<OauthStart>(`/providers/${provider.id}/oauth/authorize`, { method: "POST", body: { method } }),
    onSuccess: (start, method) => {
      setOauth({ method, start });
      window.open(start.url, "_blank", "noopener");
    },
  });
  const finishOauth = useProviderMutation((arg: { method: number; code?: string }) =>
    api<void>(`/providers/${provider.id}/oauth/callback`, { method: "POST", body: arg }),
  );

  const submitKey = (e: FormEvent) => {
    e.preventDefault();
    saveKey.mutate(key, { onSuccess: () => setKey("") });
  };
  const apiMethod = provider.methods.find((m) => m.type === "api");
  const oauthMethods = provider.methods.filter((m) => m.type === "oauth");
  const error = saveKey.error ?? remove.error ?? startOauth.error ?? finishOauth.error;

  return (
    <li className="card" aria-label={provider.name}>
      <div className="provider-head">
        <span className="card-title">{provider.name}</span>
        <span className={provider.configured ? "badge badge-inicializado" : "badge"}>
          {provider.configured ? "configurado" : "não configurado"}
        </span>
        {provider.configured && (
          <button type="button" className="danger" disabled={remove.isPending} onClick={() => remove.mutate(undefined)}>
            Remover
          </button>
        )}
      </div>
      {provider.configured && <span className="muted">Credencial salva.</span>}
      {apiMethod && (
        <form onSubmit={submitKey} className="inline-form">
          <input
            type="password"
            autoComplete="off"
            aria-label={`Chave de API de ${provider.name}`}
            placeholder={provider.configured ? "Substituir chave" : "Chave de API"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="submit" disabled={!key.trim() || saveKey.isPending}>
            Salvar chave
          </button>
        </form>
      )}
      {oauthMethods.map((m) => (
        <button key={m.index} type="button" disabled={startOauth.isPending} onClick={() => startOauth.mutate(m.index)}>
          {m.label}
        </button>
      ))}
      {oauth && (
        <div className="oauth">
          <p>{oauth.start.instructions || "Conclua a autorização na aba que foi aberta."}</p>
          <a href={oauth.start.url} target="_blank" rel="noopener noreferrer">
            Abrir página de autorização
          </a>
          {oauth.start.method === "code" ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                finishOauth.mutate({ method: oauth.method, code }, { onSuccess: () => setOauth(undefined) });
              }}
            >
              <input aria-label="Código de autorização" value={code} onChange={(e) => setCode(e.target.value)} />
              <button type="submit" disabled={!code.trim()}>
                Concluir
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => finishOauth.mutate({ method: oauth.method }, { onSuccess: () => setOauth(undefined) })}
            >
              Já autorizei
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="banner banner-error" role="alert">
          {error.message}
        </p>
      )}
    </li>
  );
}

export function DefaultModel({ data }: { data: ProvidersResponse }) {
  const configured = data.providers.filter((p) => p.configured);
  const set = useProviderMutation((model: string) =>
    api<{ applied: boolean }>("/settings/default-model", { method: "PUT", body: { model } }),
  );
  if (configured.length === 0) return null;
  return (
    <section className="card">
      <label className="default-model">
        Modelo padrão das novas sessões
        <select value={data.defaultModel ?? ""} onChange={(e) => e.target.value && set.mutate(e.target.value)}>
          <option value="">Padrão do motor</option>
          {configured.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.models.map((m) => (
                <option key={m.id} value={`${p.id}/${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {set.data && !set.data.applied && (
        <p className="muted">O agente está trabalhando; o novo modelo vale a partir do próximo reinício do motor.</p>
      )}
      {set.error && <p className="banner banner-error">{set.error.message}</p>}
    </section>
  );
}
