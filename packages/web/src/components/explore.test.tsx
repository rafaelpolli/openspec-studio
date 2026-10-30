import { afterEach, describe, expect, test } from "bun:test";
import type { DecisionCheckpoint as Checkpoint, Exploration, ExplorationSummary, RunView } from "@studio/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DecisionCheckpoint } from "./DecisionCheckpoint.tsx";
import { ExplorationList } from "./ExplorationList.tsx";
import { ExplorationView, type ExplorationActions } from "./ExplorationView.tsx";

afterEach(cleanup);

const summary = (extra: Partial<ExplorationSummary>): ExplorationSummary => ({
  id: "e1",
  workspaceId: "w",
  title: null,
  status: "ativa",
  createdAt: "2026-10-30T10:00:00Z",
  updatedAt: "2026-10-30T10:00:00Z",
  preview: "",
  ...extra,
});

const exploration = (extra: Partial<Exploration> = {}): Exploration => ({
  ...summary({ title: "BMAD no projeto" }),
  messages: [
    { id: 1, role: "usuario", text: "o que do BMAD eu poderia incluir?", status: "concluida", createdAt: "t" },
    { id: 2, role: "agente", text: "**Três** opções.", status: "concluida", createdAt: "t" },
  ],
  busy: false,
  ...extra,
});

function recorder() {
  const calls: unknown[][] = [];
  const actions: ExplorationActions = {
    send: (t) => calls.push(["send", t]),
    stop: () => calls.push(["stop"]),
    rename: (t) => calls.push(["rename", t]),
    draft: () => calls.push(["draft"]),
    toChange: (d) => calls.push(["toChange", d]),
    discard: () => calls.push(["discard"]),
    continueFrom: () => calls.push(["continue"]),
  };
  return { calls, actions };
}

describe("4.1 lista de explorações", () => {
  test("Várias explorações: title or first words, state, link to the change; Nova exploração", () => {
    let created = 0;
    render(
      <ExplorationList
        workspaceId="w"
        explorations={[
          summary({ id: "a", title: "BMAD no projeto" }),
          summary({ id: "b", title: "cache de specs", status: "virou-change", change: "add-spec-cache" }),
          summary({ id: "c", preview: "dark mode na app", status: "descartada" }),
        ]}
        creating={false}
        onCreate={() => created++}
      />,
    );
    const list = screen.getByRole("region", { name: "Explorações" });
    expect(list.textContent).toContain("BMAD no projeto");
    expect(list.textContent).toContain("virou change");
    expect(list.textContent).toContain("dark mode na app");
    expect(list.textContent).toContain("descartada");
    expect(screen.getByRole("link", { name: "→ add-spec-cache" }).getAttribute("href")).toBe("/w/w/changes/add-spec-cache");
    fireEvent.click(screen.getByRole("button", { name: "Nova exploração" }));
    expect(created).toBe(1);
  });
});

describe("4.2 página da exploração", () => {
  test("Conversa: the history with markdown, Enviar and the title edit", () => {
    const { calls, actions } = recorder();
    render(<ExplorationView workspaceId="w" exploration={exploration()} run={undefined} busy={false} actions={actions} />);
    expect(screen.getByText("Três").tagName).toBe("STRONG");
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: " detalhe a opção B " } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    fireEvent.click(screen.getByRole("button", { name: "Editar título" }));
    fireEvent.change(screen.getByLabelText("Título da exploração"), { target: { value: "BMAD" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar título" }));
    expect(calls).toEqual([["send", "detalhe a opção B"], ["rename", "BMAD"]]);
  });

  test("Parar: while the agent answers, the stream shows with Parar and Enviar is disabled; interrupted answers are marked", () => {
    const { calls, actions } = recorder();
    const run = { runId: "r", sessionId: "s", status: "rodando", startedAt: "t", transcript: [{ partId: "p", text: "pensando…" }], tools: [], files: [] } as RunView;
    const e = exploration({
      busy: true,
      messages: [...exploration().messages, { id: 3, role: "agente", text: "meia resposta", status: "interrompida", createdAt: "t" }, { id: 4, role: "agente", text: "", status: "respondendo", createdAt: "t" }],
    });
    render(<ExplorationView workspaceId="w" exploration={e} run={run} busy={false} actions={actions} />);
    expect(screen.getByText("pensando…")).toBeTruthy();
    expect(screen.getByText("Agente (interrompida)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "x" } });
    expect((screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    expect(calls).toEqual([["stop"]]);
  });

  test("Rascunho revisado: Virar change asks for the draft; edit, remove and add decisions, then Criar change", () => {
    const { calls, actions } = recorder();
    const { rerender } = render(<ExplorationView workspaceId="w" exploration={exploration()} run={undefined} busy={false} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Virar change" }));
    const draft = { name: "add-x", description: "Uma ideia.", decisions: [{ question: "Q1", answer: "A1" }, { question: "Q2", answer: "A2" }] };
    rerender(<ExplorationView workspaceId="w" exploration={exploration({ draft })} run={undefined} busy={false} actions={actions} />);
    const form = screen.getByRole("form", { name: "Virar change" });
    expect((screen.getByLabelText("Nome da change") as HTMLInputElement).value).toBe("add-x");
    fireEvent.change(screen.getByLabelText("Resposta 1"), { target: { value: "A1 editada" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Remover" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Acrescentar decisão" }));
    const create = screen.getByRole("button", { name: "Criar change" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // the new decision is empty
    fireEvent.change(screen.getByLabelText("Pergunta 2"), { target: { value: "Q3" } });
    fireEvent.change(screen.getByLabelText("Resposta 2"), { target: { value: "A3" } });
    fireEvent.change(screen.getByLabelText("Nome da change"), { target: { value: "Nome Ruim" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Nome da change"), { target: { value: "add-y" } });
    fireEvent.click(create);
    expect(form).toBeTruthy();
    expect(calls).toEqual([
      ["draft"],
      ["toChange", { name: "add-y", description: "Uma ideia.", decisions: [{ question: "Q1", answer: "A1 editada" }, { question: "Q3", answer: "A3" }] }],
    ]);
  });

  test("Virar change waits for an answer; a draft error shows; Descartar", () => {
    const { calls, actions } = recorder();
    const first = exploration({ messages: [exploration().messages[0]!], draftError: "o agente escreveu um rascunho que não é JSON" });
    render(<ExplorationView workspaceId="w" exploration={first} run={undefined} busy={false} actions={actions} />);
    expect((screen.getByRole("button", { name: "Virar change" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("não é JSON");
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(calls).toEqual([["discard"]]);
  });

  test("Change criada: read-only with the link and Continuar a partir de…", () => {
    const { calls, actions } = recorder();
    render(<ExplorationView workspaceId="w" exploration={exploration({ status: "virou-change", change: "add-x" })} run={undefined} busy={false} actions={actions} />);
    expect(screen.queryByLabelText("Mensagem")).toBeNull();
    expect(screen.queryByRole("button", { name: "Virar change" })).toBeNull();
    expect(screen.getByRole("link", { name: "add-x" }).getAttribute("href")).toBe("/w/w/changes/add-x");
    fireEvent.click(screen.getByRole("button", { name: "Continuar a partir de…" }));
    expect(calls).toEqual([["continue"]]);
  });
});

describe("4.3 decisões da exploração no checkpoint", () => {
  const cp = (extra: Partial<Checkpoint>): Checkpoint => ({
    status: "aguardando",
    decisions: [
      { id: "exploracao-1", question: "Nível de prova", options: [{ label: "B+C como base" }], recommended: 0, source: "exploracao" },
      { id: "campos", question: "Quais campos?", options: [{ label: "Todos" }, { label: "Só nome" }], recommended: 1 },
    ],
    answers: [{ id: "exploracao-1", kind: "recomendada" }],
    resumeAuto: false,
    ...extra,
  });
  const host = (c: Checkpoint) => render(<DecisionCheckpoint checkpoint={c} generated={0} busy={false} onAnswer={() => {}} onSkip={() => {}} onRetry={() => {}} />);

  test("Só as novas: the form marks the exploration's decision, without the recommendation badge", () => {
    host(cp({}));
    const legend = screen.getByText("Nível de prova").closest("legend")!;
    expect(legend.textContent).toContain("da exploração");
    expect(screen.getAllByText("recomendada")).toHaveLength(1);
  });

  test("the summary says da exploração for a kept answer, and the user's origin once edited", () => {
    host(cp({ status: "respondido", answers: [{ id: "exploracao-1", kind: "recomendada" }, { id: "campos", kind: "recomendada" }] }));
    expect(screen.getByText("(da exploração)")).toBeTruthy();
    cleanup();
    host(cp({ status: "respondido", answers: [{ id: "exploracao-1", kind: "propria", text: "só B" }, { id: "campos", kind: "recomendada" }] }));
    expect(screen.queryByText("(da exploração)")).toBeNull();
    expect(screen.getByText("(resposta própria)")).toBeTruthy();
  });
});
