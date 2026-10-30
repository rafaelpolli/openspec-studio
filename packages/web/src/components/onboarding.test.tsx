import { afterEach, describe, expect, test } from "bun:test";
import type { BaselineReview, Capability, CapabilityDraft, WorkspaceView } from "@studio/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ArchiveResults, BaselineReviewPanel, BatchProgress } from "./BatchProgress.tsx";
import { CapabilityCheckpoint, EstimateConfirm } from "./CapabilityCheckpoint.tsx";
import { InitWizard } from "./InitWizard.tsx";

afterEach(cleanup);

const draft = (name: string, path = `src/${name}`): CapabilityDraft => ({
  name,
  description: `Sobre ${name}.`,
  locations: [{ member: "api", path }],
});

const workspace: WorkspaceView = {
  id: "w1",
  name: "legado",
  kind: "mono",
  rootPath: "/repos/legado",
  storeId: null,
  members: [{ name: "legado", path: "/repos/legado" }],
  createdAt: "2026-01-01",
  projectType: "brownfield",
  hasOpenSpec: false,
  needsInit: true,
};

describe("InitWizard (8.1)", () => {
  test("submits the chosen language, or a custom tag", () => {
    const calls: string[] = [];
    render(<InitWizard workspace={workspace} onInit={(l) => calls.push(l)} />);
    expect(screen.getByText(/Cria/).textContent).toContain("/repos/legado");
    fireEvent.click(screen.getByRole("button", { name: "Inicializar" }));
    fireEvent.change(screen.getByLabelText("Idioma dos artefatos"), { target: { value: "outro" } });
    fireEvent.change(screen.getByLabelText("Código do idioma"), { target: { value: "fr" } });
    fireEvent.click(screen.getByRole("button", { name: "Inicializar" }));
    expect(calls).toEqual(["pt-BR", "fr"]);
  });

  test("a multi-repo explains that only the store is configured", () => {
    render(<InitWizard workspace={{ ...workspace, kind: "multi", storeId: "loja" }} onInit={() => {}} />);
    expect(screen.getByText(/store/).textContent).toContain("Os repositórios membros não são alterados");
  });
});

describe("CapabilityCheckpoint (8.3)", () => {
  function setup(initial: CapabilityDraft[]) {
    const saved: CapabilityDraft[][] = [];
    render(<CapabilityCheckpoint initial={initial} members={["api", "web"]} onSubmit={(c) => saved.push(c)} />);
    const submit = () => fireEvent.click(screen.getByRole("button", { name: "Continuar para a estimativa" }));
    return { saved, submit };
  }

  test("Lista ajustada: merge login + session into auth and remove legacy-reports", () => {
    const { saved, submit } = setup([draft("login"), draft("session"), draft("legacy-reports")]);
    fireEvent.click(screen.getByLabelText("Selecionar login"));
    fireEvent.click(screen.getByLabelText("Selecionar session"));
    fireEvent.change(screen.getByLabelText("Nome da capacidade mesclada"), { target: { value: "auth" } });
    fireEvent.click(screen.getByRole("button", { name: "Mesclar 2 selecionadas" }));
    fireEvent.click(screen.getByRole("button", { name: "Remover legacy-reports" }));
    submit();
    expect(saved).toEqual([
      [
        {
          name: "auth",
          description: "Sobre login. Sobre session.",
          locations: [
            { member: "api", path: "src/login" },
            { member: "api", path: "src/session" },
          ],
        },
      ],
    ]);
  });

  test("rename and add, with member:path locations", () => {
    const { saved, submit } = setup([draft("export")]);
    fireEvent.change(screen.getByLabelText("Nome de export"), { target: { value: "data-export" } });
    fireEvent.click(screen.getByText("Adicionar capacidade"));
    const add = screen.getByText("Adicionar capacidade").closest("details")!;
    fireEvent.change(within(add).getByLabelText("Nome"), { target: { value: "billing" } });
    fireEvent.change(within(add).getByLabelText("Descrição"), { target: { value: "Cobrança." } });
    fireEvent.change(within(add).getByLabelText(/Locais/), { target: { value: "web:src/pay.tsx\nsrc/billing" } });
    fireEvent.click(within(add).getByRole("button", { name: "Adicionar" }));
    submit();
    expect(saved[0]!.map((c) => c.name)).toEqual(["data-export", "billing"]);
    expect(saved[0]![1]!.locations).toEqual([
      { member: "web", path: "src/pay.tsx" },
      { member: "api", path: "src/billing" },
    ]);
  });

  test("an invalid or repeated name blocks the submit", () => {
    const { saved, submit } = setup([draft("auth"), draft("export")]);
    fireEvent.change(screen.getByLabelText("Nome de export"), { target: { value: "auth" } });
    expect(screen.getByText("Nome repetido: auth.")).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText("Nome de auth")[1]!, { target: { value: "Export Data" } });
    expect(screen.getByText(/Nome inválido/)).toBeTruthy();
    submit();
    expect(saved).toEqual([]);
  });

  test("Confirmação: the estimate is shown and generation starts only on confirm", () => {
    const calls: string[] = [];
    render(
      <EstimateConfirm
        estimate={{ capabilities: 12, files: 340, bytes: 2_500_000, tokens: { min: 700_000, max: 1_400_000 }, concurrency: 3 }}
        onConfirm={() => calls.push("confirm")}
        onBack={() => calls.push("back")}
      />,
    );
    const text = screen.getByLabelText("Estimativa").textContent!;
    expect(text).toContain("12 capacidade(s)");
    expect(text).toContain("340 arquivo(s), 2.4 MB");
    expect(text).toContain("entre 700.000 e 1.400.000 tokens");
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e gerar" }));
    expect(calls).toEqual(["confirm"]);
  });
});

const capability = (name: string, status: Capability["status"], error: string | null = null): Capability => ({
  ...draft(name),
  status,
  error,
  changeName: `baseline-${name}`,
});

describe("BatchProgress (8.6)", () => {
  test("Acompanhamento: shows each capability's state and opens any of them", () => {
    const calls: string[] = [];
    render(
      <BatchProgress
        capabilities={[
          capability("auth", "pronta"),
          capability("billing", "falhou", "Falha de autenticação no provedor de LLM: invalid api key"),
          capability("export", "gerando"),
          capability("search", "aguardando"),
        ]}
        actions={{
          open: (c) => calls.push(`open:${c}`),
          retry: (c) => calls.push(`retry:${c}`),
          cancel: (c) => calls.push(`cancel:${c}`),
        }}
      />,
    );
    expect(screen.getByTestId("status-auth").textContent).toBe("pronta para revisão");
    expect(screen.getByTestId("status-export").textContent).toBe("gerando");
    expect(screen.getByTestId("status-search").textContent).toBe("aguardando");
    expect(screen.getByRole("alert").textContent).toContain("invalid api key");
    expect(screen.getByText(/1 prontas · 1 em andamento · 1 na fila · 1 com falha/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Abrir export" }));
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    for (const b of screen.getAllByRole("button", { name: "Cancelar" })) fireEvent.click(b);
    expect(calls).toEqual(["open:export", "retry:billing", "cancel:export", "cancel:search"]);
  });
});

describe("BaselineReviewPanel (8.6 / 8.7)", () => {
  const review: BaselineReview = {
    capability: "auth",
    change: "baseline-auth",
    requirements: [
      { name: "Validar credenciais", text: "O sistema SHALL recusar.", evidence: ["api/src/auth.ts:12", "api/test/auth.test.ts:5"], inferred: false },
      { name: "Registrar tentativas", text: "O sistema SHALL registrar.", evidence: ["api/src/auth.ts:40"], inferred: true },
    ],
    files: [{ path: "design.md", content: "# Design" }],
  };

  test("Requisito sem teste and Evidência rastreável", () => {
    render(<BaselineReviewPanel review={review} status="pronta" actions={{ approve() {}, adjust() {}, discard() {} }} />);
    const tested = screen.getByRole("article", { name: "Validar credenciais" });
    const inferred = screen.getByRole("article", { name: "Registrar tentativas" });
    expect(within(tested).queryByText("inferido")).toBeNull();
    expect(within(inferred).getByText("inferido")).toBeTruthy();
    expect(within(tested).getByLabelText("Evidências de Validar credenciais").textContent).toContain("api/test/auth.test.ts:5");
    expect(within(inferred).getByText("api/src/auth.ts:40")).toBeTruthy();
  });

  test("approve, adjust and discard (after confirming)", () => {
    const calls: string[] = [];
    const original = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      render(
        <BaselineReviewPanel
          review={review}
          status="pronta"
          actions={{
            approve: () => calls.push("approve"),
            adjust: (r) => calls.push(`adjust:${r}`),
            discard: () => calls.push("discard"),
          }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Aprovar" }));
      fireEvent.change(screen.getByLabelText("Pedido de ajuste"), { target: { value: "cite os testes" } });
      fireEvent.click(screen.getByRole("button", { name: "Pedir ajuste" }));
      fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    } finally {
      globalThis.confirm = original;
    }
    expect(calls).toEqual(["approve", "adjust:cite os testes", "discard"]);
  });

  test("an approved baseline cannot be approved again", () => {
    render(<BaselineReviewPanel review={review} status="aprovada" actions={{ approve() {}, adjust() {}, discard() {} }} />);
    expect(screen.queryByRole("button", { name: "Aprovar" })).toBeNull();
  });

  test("archive results list each baseline and its error", () => {
    render(
      <ArchiveResults
        outcomes={[
          { capability: "auth", change: "baseline-auth", ok: true },
          { capability: "billing", change: "baseline-billing", ok: false, error: "Change not found" },
        ]}
      />,
    );
    const list = screen.getByLabelText("Resultado do archive").textContent!;
    expect(list).toContain("arquivada baseline-auth");
    expect(list).toContain("falhou baseline-billing: Change not found");
  });
});
