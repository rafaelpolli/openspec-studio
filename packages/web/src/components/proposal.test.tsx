import { afterEach, describe, expect, test } from "bun:test";
import type { EngineStatus, ProposalArtifact } from "@studio/shared";
import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ArtifactPanel, type ArtifactActions } from "./ArtifactPanel.tsx";
import { ProposalGraph } from "./ProposalGraph.tsx";

afterEach(cleanup);

const available: EngineStatus = { availability: "disponivel", version: "1.19.4" };
const noProvider: EngineStatus = { availability: "sem_provedor", version: "1.19.4" };
const file = { path: "proposal.md", content: "# Proposal\n\n## Why\n\nTexto original.\n" };

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const actions: ArtifactActions = {
    generate: () => calls.push(["generate"]),
    approve: () => calls.push(["approve"]),
    fix: () => calls.push(["fix"]),
    save: (path, content) => calls.push(["save", path, content]),
    adjust: (request) => calls.push(["adjust", request]),
  };
  return { calls, actions };
}

const artifact = (state: ProposalArtifact["state"], extra: Partial<ProposalArtifact> = {}): ProposalArtifact => ({
  id: "proposal",
  requires: [],
  state,
  waitingOn: [],
  issues: [],
  ...extra,
});

describe("ProposalGraph (7.x)", () => {
  test("shows each artifact's proposal state and issue count", () => {
    let picked = "";
    render(
      <ProposalGraph
        artifacts={[
          artifact("aprovado"),
          { ...artifact("aguardando_aprovacao"), id: "specs", requires: ["proposal"], issues: [{ level: "ERROR", message: "x" }] },
          { ...artifact("bloqueado"), id: "tasks", requires: ["specs"] },
        ]}
        onSelect={(id) => (picked = id)}
      />,
    );
    expect(screen.getByRole("button", { name: /^proposal/ }).getAttribute("data-state")).toBe("aprovado");
    expect(screen.getByRole("button", { name: /^specs/ }).textContent).toContain("1 problema(s)");
    fireEvent.click(screen.getByRole("button", { name: /^tasks/ }));
    expect(picked).toBe("tasks");
  });
});

describe("ArtifactPanel (7.3–7.5)", () => {
  test("a ready artifact offers Gerar, disabled while the engine has no provider", () => {
    const { calls, actions } = recorder();
    render(<ArtifactPanel artifact={artifact("pronto")} files={[]} engine={noProvider} busy={false} actions={actions} />);
    expect((screen.getByRole("button", { name: "Gerar proposal" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<ArtifactPanel artifact={artifact("pronto")} files={[]} engine={available} busy={false} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerar proposal" }));
    expect(calls).toEqual([["generate"]]);
  });

  test("Artefato bloqueado: explains what it waits for and offers no generation", () => {
    const { actions } = recorder();
    render(
      <ArtifactPanel
        artifact={{ ...artifact("bloqueado"), id: "tasks", waitingOn: ["specs", "design"] }}
        files={[]}
        engine={available}
        busy={false}
        actions={actions}
      />,
    );
    expect(screen.getByText(/Depende de: specs, design/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Gerar/ })).toBeNull();
  });

  test("Validação falha: shows the issue next to the artifact and offers the agent's fix", () => {
    const { calls, actions } = recorder();
    render(
      <ArtifactPanel
        artifact={artifact("aguardando_aprovacao", {
          id: "specs",
          issues: [{ level: "ERROR", path: "export/spec.md", message: "must include at least one scenario" }],
        })}
        files={[{ path: "specs/export/spec.md", content: "# Spec" }]}
        engine={available}
        busy={false}
        actions={actions}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("export/spec.md must include at least one scenario");
    fireEvent.click(screen.getByRole("button", { name: "Pedir correção ao agente" }));
    expect(calls).toEqual([["fix"]]);
  });

  test("Aprovar artefato and a revisar notice", () => {
    const { calls, actions } = recorder();
    render(<ArtifactPanel artifact={artifact("a_revisar")} files={[file]} engine={available} busy={false} actions={actions} />);
    expect(screen.getByText(/mudou depois da aprovação/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aprovar" }));
    expect(calls).toEqual([["approve"]]);
  });

  test("Edição salva: edits in CodeMirror are saved to the artifact's file", () => {
    const { calls, actions } = recorder();
    render(<ArtifactPanel artifact={artifact("aprovado")} files={[file]} engine={available} busy={false} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const content = screen.getByLabelText("Editor de proposal.md");
    const view = EditorView.findFromDOM(content)!;
    expect(view.state.doc.toString()).toBe(file.content);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "Parágrafo novo.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(calls).toEqual([["save", "proposal.md", `${file.content}Parágrafo novo.\n`]]);
  });

  test("Ajuste solicitado: sends the request text", () => {
    const { calls, actions } = recorder();
    render(<ArtifactPanel artifact={artifact("aprovado")} files={[file]} engine={available} busy={false} actions={actions} />);
    fireEvent.change(screen.getByLabelText("Pedir ajuste ao agente"), {
      target: { value: "remova a parte de autenticação do escopo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pedir ajuste" }));
    expect(calls).toEqual([["adjust", "remova a parte de autenticação do escopo"]]);
  });

  test("while the agent is busy, actions are disabled", () => {
    const { actions } = recorder();
    render(<ArtifactPanel artifact={artifact("aguardando_aprovacao")} files={[file]} engine={available} busy={true} actions={actions} />);
    expect((screen.getByRole("button", { name: "Aprovar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Editar" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
