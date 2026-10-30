import { CAPABILITY_NAME, type CapabilityDraft, type Estimate } from "@studio/shared";
import { useState } from "react";

function problem(caps: readonly CapabilityDraft[]): string | undefined {
  if (caps.length === 0) return "A lista precisa de pelo menos uma capacidade.";
  const seen = new Set<string>();
  for (const c of caps) {
    if (!CAPABILITY_NAME.test(c.name)) return `Nome inválido: "${c.name}" (use kebab-case).`;
    if (seen.has(c.name)) return `Nome repetido: ${c.name}.`;
    if (!c.description.trim()) return `${c.name} precisa de uma descrição.`;
    seen.add(c.name);
  }
  return undefined;
}

/** Parses "membro:caminho" lines into locations. */
function parseLocations(text: string, members: readonly string[]) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      return i > 0 ? { member: l.slice(0, i), path: l.slice(i + 1) } : { member: members[0] ?? "", path: l };
    });
}

/**
 * The checkpoint (spec: project-onboarding, "Checkpoint da lista de capacidades"): the
 * user renames, merges, removes and adds capabilities before anything is generated.
 */
export function CapabilityCheckpoint({
  initial,
  members,
  onSubmit,
  pending,
  error,
}: {
  initial: readonly CapabilityDraft[];
  members: readonly string[];
  /** Saves the list and asks for the estimate. */
  onSubmit: (caps: CapabilityDraft[]) => void;
  pending?: boolean;
  error?: string | undefined;
}) {
  const [caps, setCaps] = useState<CapabilityDraft[]>(() => initial.map((c) => ({ ...c, locations: [...c.locations] })));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mergeName, setMergeName] = useState("");
  const [draft, setDraft] = useState({ name: "", description: "", locations: "" });
  const invalid = problem(caps);

  const update = (i: number, patch: Partial<CapabilityDraft>) =>
    setCaps((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const toggle = (i: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const merge = () => {
    const picked = caps.filter((_, i) => selected.has(i));
    const merged: CapabilityDraft = {
      name: mergeName.trim(),
      description: picked.map((c) => c.description).join(" "),
      locations: picked.flatMap((c) => c.locations).filter(
        (l, i, all) => all.findIndex((x) => x.member === l.member && x.path === l.path) === i,
      ),
    };
    const first = Math.min(...selected);
    setCaps((list) => list.flatMap((c, i) => (i === first ? [merged] : selected.has(i) ? [] : [c])));
    setSelected(new Set());
    setMergeName("");
  };

  return (
    <section aria-label="Checkpoint de capacidades">
      <p className="muted">
        Revise a lista antes de gerar: renomeie, mescle, remova ou adicione capacidades. Cada uma vira uma change{" "}
        <code>baseline-&lt;nome&gt;</code>.
      </p>
      <ul className="cards">
        {caps.map((c, i) => (
          <li key={i} className="card capability">
            <div className="capability-head">
              <input
                type="checkbox"
                aria-label={`Selecionar ${c.name}`}
                checked={selected.has(i)}
                onChange={() => toggle(i)}
              />
              <input aria-label={`Nome de ${c.name}`} value={c.name} onChange={(e) => update(i, { name: e.target.value })} />
              <button
                type="button"
                className="danger"
                aria-label={`Remover ${c.name}`}
                onClick={() => {
                  setCaps((list) => list.filter((_, j) => j !== i));
                  setSelected(new Set());
                }}
              >
                Remover
              </button>
            </div>
            <input
              aria-label={`Descrição de ${c.name}`}
              value={c.description}
              onChange={(e) => update(i, { description: e.target.value })}
            />
            <span className="muted file-path">
              {c.locations.map((l) => `${l.member}:${l.path}`).join(", ") || "sem locais"}
            </span>
          </li>
        ))}
      </ul>

      {selected.size >= 2 && (
        <div className="inline-form" role="group" aria-label="Mesclar">
          <input
            aria-label="Nome da capacidade mesclada"
            placeholder="nome-mesclado"
            value={mergeName}
            onChange={(e) => setMergeName(e.target.value)}
          />
          <button type="button" disabled={!CAPABILITY_NAME.test(mergeName.trim())} onClick={merge}>
            Mesclar {selected.size} selecionadas
          </button>
        </div>
      )}

      <details className="add-capability">
        <summary>Adicionar capacidade</summary>
        <div className="form">
          <label>
            Nome
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            Descrição
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <label>
            Locais (um por linha, <code>membro:caminho</code>; membros: {members.join(", ")})
            <textarea
              rows={2}
              value={draft.locations}
              onChange={(e) => setDraft({ ...draft, locations: e.target.value })}
            />
          </label>
          <button
            type="button"
            disabled={!CAPABILITY_NAME.test(draft.name.trim()) || !draft.description.trim()}
            onClick={() => {
              setCaps((list) => [
                ...list,
                {
                  name: draft.name.trim(),
                  description: draft.description.trim(),
                  locations: parseLocations(draft.locations, members),
                },
              ]);
              setDraft({ name: "", description: "", locations: "" });
            }}
          >
            Adicionar
          </button>
        </div>
      </details>

      {invalid && <p className="banner banner-warn">{invalid}</p>}
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" disabled={!!invalid || pending} onClick={() => onSubmit(caps)}>
          Continuar para a estimativa
        </button>
      </div>
    </section>
  );
}

const fmt = new Intl.NumberFormat("pt-BR");

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Cost estimate shown before the batch, which starts only on confirmation ("Estimar custo antes de gerar"). */
export function EstimateConfirm({
  estimate,
  onConfirm,
  onBack,
  pending,
  confirmDisabled,
}: {
  estimate: Estimate;
  onConfirm: () => void;
  onBack: () => void;
  pending?: boolean;
  confirmDisabled?: boolean;
}) {
  return (
    <section className="estimate" aria-label="Estimativa">
      <h3>Antes de gerar</h3>
      <ul>
        <li>
          <strong>{estimate.capabilities}</strong> capacidade(s), uma sessão de agente para cada, até {estimate.concurrency} ao
          mesmo tempo
        </li>
        <li>
          Código a ler: <strong>{fmt.format(estimate.files)}</strong> arquivo(s), {size(estimate.bytes)}
        </li>
        <li>
          Custo aproximado: entre {fmt.format(estimate.tokens.min)} e {fmt.format(estimate.tokens.max)} tokens
        </li>
      </ul>
      <div className="actions">
        <button type="button" onClick={onBack}>
          Voltar à lista
        </button>
        <button type="button" onClick={onConfirm} disabled={pending || confirmDisabled}>
          Confirmar e gerar
        </button>
      </div>
    </section>
  );
}
