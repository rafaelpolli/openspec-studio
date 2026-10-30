import { afterEach, describe, expect, test } from "bun:test";
import type { SpecScenario, VerificationItem, VerificationState } from "@studio/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { VerificationPanel, type ArchiveError, type VerificationActions } from "./VerificationPanel.tsx";

afterEach(cleanup);

const scenario = (name: string, requirement = "Somar"): SpecScenario => ({ id: `calc/${requirement}/${name}`, capability: "calc", requirement, name, text: "" });
const item = (name: string, extra: Partial<VerificationItem> = {}): VerificationItem => ({
  id: `calc/Somar/${name}`,
  kind: "cenario",
  scenario: scenario(name),
  result: "coberto",
  ...extra,
});
const covered = (name: string, extra: Partial<VerificationItem> = {}) =>
  item(name, { evidence: { member: "app", file: "src/soma.test.ts", line: 5, name: `${name}: teste` }, output: "1 pass", command: ["bun", "test"], ...extra });

function state(items: VerificationItem[], extra: Partial<VerificationState> = {}): VerificationState {
  const verdict = items.some((i) => i.result === "falhou") ? "FAIL" : items.some((i) => i.result !== "coberto") ? "CONCERNS" : "PASS";
  return {
    change: "c",
    report: { id: "v1", change: "c", status: "concluida", createdAt: "t", items, verdict },
    stale: false,
    canStart: true,
    archive: { allowed: verdict === "PASS", ...(verdict === "PASS" ? {} : { reason: "justifique os itens" }), missing: [], git: true },
    ...extra,
  };
}

function recorder() {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
  const actions: VerificationActions = {
    run: rec("run"),
    stop: rec("stop"),
    prove: rec("prove"),
    check: rec("check"),
    uncheck: rec("uncheck"),
    justify: rec("justify"),
    testTask: rec("testTask"),
    archive: rec("archive"),
    archiveCommit: rec("archiveCommit"),
  };
  return { calls, actions };
}

function panel(s: VerificationState, opts: { committing?: boolean; archiveError?: ArchiveError; onCommitDialog?: (open: boolean) => void } = {}) {
  const { calls, actions } = recorder();
  render(
    <VerificationPanel
      change="c"
      state={s}
      busy={false}
      archiveError={opts.archiveError}
      committing={opts.committing ?? false}
      onCommitDialog={opts.onCommitDialog ?? (() => {})}
      actions={actions}
    />,
  );
  return calls;
}

const li = (name: string) => screen.getAllByRole("listitem").find((l) => l.textContent?.includes(name))!;

describe("7.1 painel de verificação", () => {
  test("Tudo coberto: PASS, the evidence, the output, and Provar calls with the item id", () => {
    const calls = panel(state([covered("Passa")]));
    expect(screen.getByRole("region", { name: "Verificação" })).toBeTruthy();
    expect(screen.getByText("Veredito: PASS")).toBeTruthy();
    const row = li("Passa");
    expect(row.className).toContain("verification-item");
    expect(row.textContent).toContain("app/src/soma.test.ts:5");
    expect(within(row).getByText("coberto")).toBeTruthy();
    expect(within(row).getByText("Saída")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Provar" }));
    fireEvent.click(screen.getByRole("button", { name: "Verificar change" }));
    expect(calls).toEqual([["prove", "calc/Somar/Passa"], ["run"]]);
    expect((screen.getByRole("button", { name: "Arquivar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("CONCERNS: a manual item is checked; sem teste gets a task or a justification", () => {
    const calls = panel(state([item("Manual", { result: "manual" }), item("Sem teste", { result: "sem-teste" })]));
    expect(screen.getByText("Veredito: CONCERNS")).toBeTruthy();
    fireEvent.click(within(li("Manual")).getByRole("button", { name: "Conferido" }));
    const row = li("Sem teste");
    expect(within(row).getByText("sem teste")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Gerar task de teste" }));
    fireEvent.click(within(row).getByRole("button", { name: "Justificar" }));
    fireEvent.change(within(row).getByLabelText("Justificativa"), { target: { value: "coberto pelo E2E" } });
    fireEvent.click(within(row).getByRole("button", { name: "Salvar justificativa" }));
    expect(calls).toEqual([
      ["check", "calc/Somar/Manual"],
      ["testTask", "calc/Somar/Sem teste"],
      ["justify", "calc/Somar/Sem teste", "coberto pelo E2E"],
    ]);
  });

  test("a checked manual item can be unchecked; proofs and their labels", () => {
    const calls = panel(
      state([
        item("Manual", { result: "manual", checked: { note: "olhei" } }),
        covered("Forte", { proof: { status: "concluida", result: "forte" } }),
        covered("Rodando", { proof: { status: "rodando" } }),
      ]),
    );
    expect(within(li("Manual")).getByText("manual (conferido)")).toBeTruthy();
    fireEvent.click(within(li("Manual")).getByRole("button", { name: "Desfazer conferência" }));
    expect(within(li("Forte")).getByText("prova forte")).toBeTruthy();
    expect(within(li("Rodando")).getByText("provando…")).toBeTruthy();
    expect(within(li("Rodando")).queryByRole("button", { name: "Provar" })).toBeNull();
    expect(calls).toEqual([["uncheck", "calc/Somar/Manual"]]);
  });

  test("FAIL with the failed item and the gate reason; an invalid evidence offers a test task", () => {
    panel(
      state([covered("Falha", { result: "falhou", output: "expected 3" }), item("Inválida", { result: "evidencia-invalida", reason: "o nome do teste não aparece perto da linha 1" })], {
        archive: { allowed: false, reason: "há testes falhando: corrija e verifique de novo", missing: [], git: true },
      }),
    );
    expect(screen.getByText("Veredito: FAIL")).toBeTruthy();
    expect(within(li("Falha")).getByText("falhou")).toBeTruthy();
    expect(within(li("Inválida")).getByText("evidência inválida")).toBeTruthy();
    expect(within(li("Inválida")).getByRole("button", { name: "Gerar task de teste" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Arquivar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Arquivar e commitar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("há testes falhando: corrija e verifique de novo")).toBeTruthy();
  });

  test("Relatório desatualizado, a start reason, the last error, a running verification and an unavailable proof", () => {
    const s = state([covered("Passa")], { stale: true, canStart: false, startReason: "aceite ou desfaça antes as tasks em aberto (2.1)", lastError: "o agente falhou", proofUnavailable: "sem retrato" });
    panel(s);
    expect(screen.getByText("Relatório desatualizado")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Verificar change" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("aceite ou desfaça antes as tasks em aberto (2.1)")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("o agente falhou");
    expect(screen.queryByRole("button", { name: "Provar" })).toBeNull();
    expect(screen.getByText(/indisponível: sem retrato/)).toBeTruthy();
    cleanup();
    const calls = panel({ ...s, running: { ...s.report!, id: "v2", status: "rodando", items: [covered("Passa", { result: "rodando" })] } });
    expect(within(li("Passa")).getByText("rodando")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Parar verificação" }));
    expect(calls).toEqual([["stop"]]);
  });
});

describe("7.2 arquivar com o portão", () => {
  const pending: VerificationItem = { id: "tasks-pendentes", kind: "tasks-pendentes", pendingTasks: ["1.2", "1.3"], result: "aguardando", justification: "fica para depois" };

  test("CONCERNS sem justificativa: the items still missing are listed; tasks pendentes can be justified", () => {
    const calls = panel(
      state([item("Manual", { result: "manual" }), { id: "tasks-pendentes", kind: "tasks-pendentes", pendingTasks: ["1.2", "1.3"], result: "aguardando" }], {
        archive: { allowed: false, reason: "justifique os itens que deixam o veredito em CONCERNS (2)", missing: ["calc/Somar/Manual", "tasks-pendentes"], git: false },
      }),
    );
    expect(screen.getByText("Falta justificar: Manual, tasks pendentes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Arquivar e commitar" })).toBeNull();
    const row = li("Tasks pendentes: 1.2, 1.3");
    fireEvent.click(within(row).getByRole("button", { name: "Justificar" }));
    fireEvent.change(within(row).getByLabelText("Justificativa"), { target: { value: "depois" } });
    fireEvent.click(within(row).getByRole("button", { name: "Salvar justificativa" }));
    expect(calls).toEqual([["justify", "tasks-pendentes", "depois"]]);
  });

  test("Arquivar asks for confirmation, listing the pending tasks", () => {
    const s = state([covered("Passa"), pending]);
    const calls = panel({ ...s, archive: { allowed: true, missing: [], git: true } });
    fireEvent.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(screen.getByRole("alertdialog", { name: "Confirmar archive" }).textContent).toContain("Tasks ainda pendentes: 1.2, 1.3.");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar archive" }));
    expect(calls).toEqual([["archive"]]);
  });

  test("Arquivar e commitar: the dialog with archive: <change>, the commit, and a hook failure's way out", () => {
    const opened: boolean[] = [];
    const s = state([covered("Passa")]);
    let calls = panel(s, { onCommitDialog: (o) => opened.push(o) });
    fireEvent.click(screen.getByRole("button", { name: "Arquivar e commitar" }));
    expect(opened).toEqual([true]);
    cleanup();
    calls = panel(s, { committing: true });
    const dialog = screen.getByRole("form", { name: "Arquivar e commitar" });
    expect((within(dialog).getByLabelText("Mensagem do commit") as HTMLTextAreaElement).value).toBe("archive: c");
    fireEvent.click(within(dialog).getByRole("button", { name: "Commitar" }));
    expect(calls).toEqual([["archiveCommit", "archive: c", false]]);
    cleanup();
    calls = panel(s, {
      committing: true,
      archiveError: { message: "um hook recusou o commit", git: { kind: "hook", output: "recusado" }, archived: true },
    });
    const failed = screen.getByRole("form", { name: "Arquivar e commitar" });
    expect(within(failed).getByText("A change já foi arquivada; falta só o commit.")).toBeTruthy();
    expect(within(failed).getByLabelText("Saída do Git").textContent).toBe("recusado");
    fireEvent.click(within(failed).getByRole("button", { name: "Tentar de novo" }));
    fireEvent.click(within(failed).getByRole("button", { name: "Commitar sem hooks" }));
    expect(calls).toEqual([
      ["archiveCommit", "archive: c", false],
      ["archiveCommit", "archive: c", true],
    ]);
  });

  test("Falha do archive (not Git): the message is shown next to the archive buttons", () => {
    panel(state([covered("Passa")]), { archiveError: { message: "openspec archive falhou: spec inválida" } });
    expect(screen.getByRole("alert").textContent).toBe("openspec archive falhou: spec inválida");
  });
});
