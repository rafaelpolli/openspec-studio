import type { ProposalView } from "@studio/shared";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../api.ts";

/** Starts a change from a description; the suggested name can be edited (spec: "Iniciar uma change"). */
export function NewChangePage({ id }: { id: string }) {
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (touched || description.trim().length < 3) return;
    const timer = setTimeout(async () => {
      const res = await api<{ name: string }>(`/suggest-name?description=${encodeURIComponent(description)}`);
      setName(res.name);
    }, 250);
    return () => clearTimeout(timer);
  }, [description, touched]);

  const create = useMutation({
    mutationFn: () => api<ProposalView>(`/workspaces/${id}/changes`, { method: "POST", body: { name, description } }),
    onSuccess: (view) => navigate(`/w/${id}/changes/${view.change}`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <main>
      <Link href={`/w/${id}`} className="muted">
        ← workspace
      </Link>
      <h1>Nova change</h1>
      <form className="form" onSubmit={submit}>
        <label>
          O que você quer construir ou mudar?
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="ex.: exportar dados do usuário em CSV"
            required
          />
        </label>
        <label>
          Nome da change (kebab-case)
          <input
            value={name}
            onChange={(e) => {
              setTouched(true);
              setName(e.target.value);
            }}
            pattern="[a-z0-9][a-z0-9\\-]*"
            required
          />
        </label>
        {create.isError && (
          <p className="banner banner-error" role="alert">
            {create.error.message}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={create.isPending || !name}>
            Criar change
          </button>
        </div>
      </form>
    </main>
  );
}
