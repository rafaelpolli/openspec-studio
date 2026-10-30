import { afterEach, describe, expect, test } from "bun:test";
import type { DecisionAnswer, DecisionCheckpoint as Checkpoint, EngineStatus, ProposalArtifact } from "@studio/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ArtifactPanel, type ArtifactActions } from "./ArtifactPanel.tsx";
import { DecisionCheckpoint } from "./DecisionCheckpoint.tsx";

afterEach(cleanup);

const DECISIONS: Checkpoint["decisions"] = [
  { id: "campos", question: "Quais campos entram no CSV?", why: "privacidade", options: [{ label: "Todos" }, { label: "Só nome e e-mail" }], recommended: 1 },
  { id: "formato", question: "Formato da data?", options: [{ label: "ISO 8601" }, { label: "dd/mm/aaaa" }], recommended: 0 },
];
const checkpoint = (extra: Partial<Checkpoint> = {}): Checkpoint => ({ status: "aguardando", decisions: DECISIONS, answers: [], resumeAuto: false, ...extra });

function host(cp: Checkpoint, generated = 0) {
  const calls: unknown[][] = [];
  render(
    <DecisionCheckpoint
      checkpoint={cp}
      generated={generated}
      busy={false}
      onAnswer={(a) => calls.push(["answer", a])}
      onSkip={() => calls.push(["skip"])}
      onRetry={() => calls.push(["retry"])}
    />,
  );
  return calls;
}

describe("5.1 checkpoint de decisões", () => {
  test("Decisões levantadas: the recommendation is pre-selected; an own answer and another option are sent as such", () => {
    const calls = host(checkpoint());
    expect(screen.getByText("privacidade")).toBeTruthy();
    expect((screen.getAllByRole("radio", { name: /Só nome e e-mail/ })[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getAllByRole("radio", { name: "Outra resposta" })[0]!);
    const save = screen.getByRole("button", { name: "Salvar respostas" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Outra resposta para Quais campos entram no CSV?"), { target: { value: " só o e-mail " } });
    fireEvent.click(screen.getByRole("radio", { name: "dd/mm/aaaa" }));
    fireEvent.click(save);
    expect(calls).toEqual([
      [
        "answer",
        [
          { id: "campos", kind: "propria", text: "só o e-mail" },
          { id: "formato", kind: "opcao", option: 1 },
        ] satisfies DecisionAnswer[],
      ],
    ]);
  });

  test("Aceitar as recomendações and Pular", () => {
    const calls = host(checkpoint());
    fireEvent.click(screen.getByRole("button", { name: "Aceitar recomendações" }));
    fireEvent.click(screen.getByRole("button", { name: "Pular" }));
    expect(calls).toEqual([
      ["answer", [{ id: "campos", kind: "recomendada" }, { id: "formato", kind: "recomendada" }]],
      ["skip"],
    ]);
  });

  test("levantando, falhou (Tentar de novo / Pular), nenhuma decisão and pulado", () => {
    let calls = host(checkpoint({ status: "levantando", decisions: [] }));
    expect(screen.getByText(/está lendo a descrição e o código/)).toBeTruthy();
    cleanup();
    calls = host(checkpoint({ status: "falhou", decisions: [], error: "sem chave" }));
    expect(screen.getByRole("alert").textContent).toContain("sem chave");
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    fireEvent.click(screen.getByRole("button", { name: "Pular" }));
    expect(calls).toEqual([["retry"], ["skip"]]);
    cleanup();
    host(checkpoint({ status: "respondido", decisions: [] }));
    expect(screen.getByText(/não encontrou decisões a tomar/)).toBeTruthy();
    cleanup();
    host(checkpoint({ status: "pulado" }));
    expect(screen.getByText(/Decisões puladas/)).toBeTruthy();
  });

  test("Resposta alterada depois: the summary, Editar respostas with the a revisar warning, starting from the saved answers", () => {
    const answers: DecisionAnswer[] = [{ id: "campos", kind: "propria", text: "só o e-mail" }, { id: "formato", kind: "recomendada" }];
    const calls = host(checkpoint({ status: "respondido", answers }), 2);
    expect(screen.getByText(/só o e-mail/).textContent).toContain("só o e-mail");
    expect(screen.getByText("(resposta própria)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Editar respostas" }));
    expect(screen.getByText(/os 2 artefatos já gerados/)).toBeTruthy();
    expect((screen.getByLabelText("Outra resposta para Quais campos entram no CSV?") as HTMLInputElement).value).toBe("só o e-mail");
    expect(screen.queryByRole("button", { name: "Pular" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "dd/mm/aaaa" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar respostas" }));
    expect(calls).toEqual([["answer", [answers[0], { id: "formato", kind: "opcao", option: 1 }]]]);
    expect(screen.getByRole("button", { name: "Editar respostas" })).toBeTruthy();
  });
});

describe("5.2 suposições no ArtifactPanel", () => {
  const available: EngineStatus = { availability: "disponivel", version: "1.19.4" };
  const file = { path: "design.md", content: "# Design\n" };
  const artifact = (extra: Partial<ProposalArtifact>): ProposalArtifact => ({ id: "design", requires: ["proposal"], state: "aguardando_aprovacao", waitingOn: [], issues: [], ...extra });
  const actions = (calls: unknown[][]): ArtifactActions => ({
    generate: () => {},
    approve: () => calls.push(["approve"]),
    fix: () => {},
    save: () => {},
    adjust: (r) => calls.push(["adjust", r]),
  });

  test("Suposição mostrada and Ajustar: the request starts about the assumption", () => {
    const calls: unknown[][] = [];
    const a = artifact({ assumptions: [{ text: "o export roda em segundo plano" }, { text: "até 10 mil linhas", question: "Qual o limite?" }] });
    render(<ArtifactPanel artifact={a} files={[file]} engine={available} busy={false} actions={actions(calls)} />);
    const list = screen.getByRole("region", { name: "Suposições do agente" });
    expect(list.textContent).toContain("o export roda em segundo plano");
    expect(list.textContent).toContain("(pergunta do agente: Qual o limite?)");
    fireEvent.click(screen.getAllByRole("button", { name: "Ajustar" })[0]!);
    const input = screen.getByLabelText("Pedir ajuste ao agente") as HTMLInputElement;
    expect(input.value).toBe('Sobre a suposição "o export roda em segundo plano": ');
    fireEvent.change(input, { target: { value: `${input.value}é sempre síncrono` } });
    fireEvent.click(screen.getByRole("button", { name: "Pedir ajuste" }));
    expect(calls).toEqual([["adjust", 'Sobre a suposição "o export roda em segundo plano": é sempre síncrono']]);
  });

  test("more than 5 assumptions collapse; none, or an approved artifact, show no list", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ text: `s${i}` }));
    render(<ArtifactPanel artifact={artifact({ assumptions: many })} files={[file]} engine={available} busy={false} actions={actions([])} />);
    expect(screen.getByText("Suposições do agente (6)")).toBeTruthy();
    cleanup();
    render(<ArtifactPanel artifact={artifact({ state: "aprovado", assumptions: many })} files={[file]} engine={available} busy={false} actions={actions([])} />);
    expect(screen.queryByRole("region", { name: "Suposições do agente" })).toBeNull();
  });

  test("the reason for a revisar by decisions, and the proposal waiting on the decisions", () => {
    render(<ArtifactPanel artifact={artifact({ state: "a_revisar", staleDecisions: true })} files={[file]} engine={available} busy={false} actions={actions([])} />);
    expect(screen.getByText(/Uma decisão da change mudou depois que este artefato foi gerado/)).toBeTruthy();
    cleanup();
    render(
      <ArtifactPanel artifact={artifact({ id: "proposal", requires: [], state: "bloqueado", waitingOn: ["decisões"] })} files={[]} engine={available} busy={false} actions={actions([])} />,
    );
    expect(screen.getByText("Responda ou pule as decisões da change antes de gerar.")).toBeTruthy();
  });
});
