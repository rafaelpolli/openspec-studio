import { afterEach, describe, expect, test } from "bun:test";
import type { ApplyState, ApplyTask } from "@studio/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApplyPanel, CommandListEditor, PermissionDialog, TaskReview, type ApplyActions } from "./ApplyPanel.tsx";

afterEach(cleanup);

function recorder() {
  const calls: unknown[][] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args]);
  const actions: ApplyActions = {
    run: rec("run"),
    confirm: rec("confirm"),
    dismiss: rec("dismiss"),
    stop: rec("stop"),
    accept: rec("accept"),
    undo: rec("undo"),
    adjust: rec("adjust"),
    reply: rec("reply"),
    commit: rec("commit"),
    resolveWarning: rec("resolve"),
    setIdentity: async (...args: unknown[]) => calls.push(["identity", ...args]),
  };
  return { calls, actions };
}

const task = (id: string, status: ApplyTask["status"], extra: Partial<ApplyTask> = {}): ApplyTask => ({
  id,
  text: `Criar ${id}`,
  section: "1. Core",
  status,
  ...extra,
});

const state = (tasks: ApplyTask[], extra: Partial<ApplyState> = {}): ApplyState => ({
  change: "c",
  hasTasks: true,
  running: false,
  tasks,
  ...extra,
});

describe("5.1 painel de apply", () => {
  test("Executar próxima and Executar todas start a run; tasks show their state", () => {
    const { calls, actions } = recorder();
    render(<ApplyPanel state={state([task("1.1", "aceita"), task("1.2", "pendente")])} busy={false} actions={actions} />);
    expect(screen.getByText("aceita")).toBeTruthy();
    expect(screen.getByText("pendente")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Executar próxima" }));
    fireEvent.click(screen.getByRole("button", { name: "Executar todas" }));
    expect(calls).toEqual([
      ["run", "proxima"],
      ["run", "todas"],
    ]);
  });

  test("Change sem tasks: the buttons are unavailable and the panel says why", () => {
    const { actions } = recorder();
    render(<ApplyPanel state={state([], { hasTasks: false })} busy={false} actions={actions} />);
    expect((screen.getByRole("button", { name: "Executar próxima" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Gere as tasks da change antes de executar.")).toBeTruthy();
  });

  test("while running only Parar is offered, with the note not to edit files", () => {
    const { calls, actions } = recorder();
    render(<ApplyPanel state={state([task("1.1", "rodando"), task("1.2", "na-fila")], { running: true })} busy actions={actions} />);
    expect(screen.queryByRole("button", { name: "Executar próxima" })).toBeNull();
    expect(screen.getByText("na fila")).toBeTruthy();
    expect(screen.getByText(/Evite editar os arquivos/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    expect(calls).toEqual([["stop"]]);
  });

  test("member warnings ask for confirmation before running", () => {
    const { calls, actions } = recorder();
    render(
      <ApplyPanel
        state={state([task("1.1", "pendente")])}
        warnings={[
          { member: "legado", kind: "sem-git" },
          { member: "repo-api", kind: "alteracoes-pendentes" },
        ]}
        busy={false}
        actions={actions}
      />,
    );
    expect(screen.getByText(/legado não é um repositório Git/)).toBeTruthy();
    expect(screen.getByText(/repo-api tem alterações não commitadas/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continuar mesmo assim" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(calls).toEqual([["confirm"], ["dismiss"]]);
  });
});

describe("5.2 revisão da task", () => {
  const reviewed = task("1.2", "aguardando-revisao", {
    summary: "Criei o formulário e rodei os testes.",
    canUndo: true,
    diff: [
      { member: "repo-web", git: true, files: [{ path: "src/msg.ts", change: "criado", patch: "+export const msg = 1;" }] },
      { member: "legado", git: false, files: [], written: ["/legado/x.ts"] },
    ],
  });

  test("shows the summary and the diff by member, and accepts, undoes and adjusts", () => {
    const { calls, actions } = recorder();
    render(<TaskReview task={reviewed} busy={false} actions={actions} />);
    expect(screen.getByText("Criei o formulário e rodei os testes.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "repo-web" })).toBeTruthy();
    expect(screen.getByText("src/msg.ts")).toBeTruthy();
    expect(screen.getByText("+export const msg = 1;")).toBeTruthy();
    expect(screen.getByText("/legado/x.ts")).toBeTruthy();
    expect(screen.getByText(/Sem Git em legado/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aceitar" }));
    fireEvent.click(screen.getByRole("button", { name: "Desfazer" }));
    fireEvent.change(screen.getByLabelText("Pedir ajuste"), { target: { value: "use loginError" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajustar" }));
    expect(calls).toEqual([
      ["accept", "1.2"],
      ["undo", "1.2"],
      ["adjust", "1.2", "use loginError"],
    ]);
  });

  test("Desfazer fora de ordem: undo and adjust are unavailable for an older task", () => {
    const { actions } = recorder();
    render(<TaskReview task={{ ...reviewed, canUndo: false }} busy={false} actions={actions} />);
    const undo = screen.getByRole("button", { name: "Desfazer" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    expect(undo.title).toBe("Desfaça antes a task mais recente");
    fireEvent.change(screen.getByLabelText("Pedir ajuste"), { target: { value: "algo" } });
    expect((screen.getByRole("button", { name: "Ajustar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("an incomplete task shows its error and cannot be accepted", () => {
    const { actions } = recorder();
    render(<TaskReview task={task("1.3", "incompleta", { error: "A task foi interrompida", canUndo: true })} busy={false} actions={actions} />);
    expect(screen.getByRole("alert").textContent).toBe("A task foi interrompida");
    expect(screen.queryByRole("button", { name: "Aceitar" })).toBeNull();
    expect(screen.getByText("A task não alterou arquivos.")).toBeTruthy();
  });

  test("the panel opens the latest task under review", () => {
    const { actions } = recorder();
    render(<ApplyPanel state={state([task("1.1", "aguardando-revisao"), reviewed])} busy={false} actions={actions} />);
    expect(screen.getByRole("article", { name: "Revisão da task 1.2" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Revisar" })[0]!);
    expect(screen.getByRole("article", { name: "Revisão da task 1.1" })).toBeTruthy();
  });
});

describe("5.3 pedido de comando e lista de comandos", () => {
  test("the dialog shows the command and the three answers", () => {
    const replies: string[] = [];
    render(
      <PermissionDialog request={{ requestId: "p1", permission: "bash", patterns: ["bun run lint"] }} onReply={(r) => replies.push(r)} />,
    );
    expect(screen.getByText("bun run lint")).toBeTruthy();
    for (const name of ["Permitir uma vez", "Sempre neste workspace", "Recusar"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(replies).toEqual(["once", "always", "reject"]);
  });

  test("a pending request in the state shows the dialog again on reopening the screen", () => {
    const { calls, actions } = recorder();
    render(
      <ApplyPanel
        state={state([task("1.1", "aguardando-permissao")], {
          running: true,
          permission: { requestId: "p9", permission: "bash", patterns: ["make"] },
        })}
        busy
        actions={actions}
      />,
    );
    expect(screen.getByText("aguardando permissão")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Permitir uma vez" }));
    expect(calls).toEqual([["reply", "p9", "once"]]);
  });

  test("the command list is edited one command per line", () => {
    const saved: string[][] = [];
    render(<CommandListEditor commands={["bun test"]} saving={false} onSave={(c) => saved.push(c)} />);
    fireEvent.change(screen.getByLabelText(/Comandos liberados/), { target: { value: "bun test\nbun run lint" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar comandos" }));
    expect(saved).toEqual([["bun test", "bun run lint"]]);
  });
});

describe("6.1 aceitar e commitar", () => {
  const commit = { allowed: true, message: "c: 1.2 Criar 1.2", repos: ["repo-api", "openspec"], done: [] };
  const reviewed = (extra: Partial<ApplyTask> = {}) =>
    task("1.2", "aguardando-revisao", {
      canUndo: true,
      diff: [{ member: "repo-api", git: true, files: [{ path: "src/a.ts", change: "modificado", patch: "+a" }] }],
      commit,
      ...extra,
    });

  test("opens the dialog with the suggested message, editable, and the repos that get a commit", () => {
    const { calls, actions } = recorder();
    render(<TaskReview task={reviewed()} busy={false} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceitar e commitar" }));
    const message = screen.getByLabelText("Mensagem do commit") as HTMLTextAreaElement;
    expect(message.value).toBe("c: 1.2 Criar 1.2");
    expect(screen.getByText(/Um commit em: repo-api, openspec/)).toBeTruthy();
    fireEvent.change(message, { target: { value: "feat: login" } });
    fireEvent.click(screen.getByRole("button", { name: "Commitar" }));
    expect(calls).toEqual([["commit", "1.2", "feat: login", false]]);
  });

  test("Commitar fora de ordem: the button is disabled with the reason", () => {
    const { actions } = recorder();
    const reason = "aceite ou desfaça antes as tasks anteriores";
    render(<TaskReview task={reviewed({ commit: { ...commit, allowed: false, reason } })} busy={false} actions={actions} />);
    const button = screen.getByRole("button", { name: "Aceitar e commitar" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(reason);
    expect(screen.getByText(/tasks anteriores/)).toBeTruthy();
  });

  test("Arquivo já alterado antes da task: the warning replaces the button; plain accept stays", () => {
    const { actions } = recorder();
    const diff = [{ member: "repo-api", git: true, files: [{ path: "src/a.ts", change: "modificado" as const, patch: "+a" }], dirtyBefore: ["src/a.ts"] }];
    render(<TaskReview task={reviewed({ diff, commit: { ...commit, allowed: false, reason: "há arquivos" } })} busy={false} actions={actions} />);
    expect(screen.queryByRole("button", { name: "Aceitar e commitar" })).toBeNull();
    expect(screen.getByRole("note").textContent).toContain("repo-api/src/a.ts");
    expect(screen.getByRole("button", { name: "Aceitar" })).toBeTruthy();
  });

  test("Hook recusa o commit: the output, and Commitar sem hooks", () => {
    const { calls, actions } = recorder();
    const error = { message: "um hook do repo recusou o commit", git: { kind: "hook" as const, output: "lint: 2 erros" } };
    render(<TaskReview task={reviewed({ commit: { ...commit, done: ["repo-api"] } })} busy={false} actions={actions} commitError={error} />);
    expect(screen.getByLabelText("Saída do Git").textContent).toBe("lint: 2 erros");
    expect(screen.getByText(/Já commitado numa tentativa anterior: repo-api/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Commitar sem hooks" }));
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(calls).toEqual([
      ["commit", "1.2", "c: 1.2 Criar 1.2", true],
      ["commit", "1.2", "c: 1.2 Criar 1.2", false],
    ]);
  });

  test("Sem identidade: the identity form, then the commit is tried again", async () => {
    const { calls, actions } = recorder();
    const error = { message: "o Git não sabe quem é o autor", git: { kind: "identidade" as const, output: "Please tell me who you are" } };
    render(<TaskReview task={reviewed()} busy={false} actions={actions} commitError={error} />);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@x" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar identidade e tentar de novo" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([
      ["identity", "Ana", "ana@x"],
      ["commit", "1.2", "c: 1.2 Criar 1.2", false],
    ]);
  });

  test("Assinatura que pede senha: no retry, only the explanation", () => {
    const { actions } = recorder();
    const error = { message: "faça este commit pelo terminal", git: { kind: "assinatura" as const, output: "" } };
    render(<TaskReview task={reviewed()} busy={false} actions={actions} commitError={error} />);
    expect(screen.getByRole("alert").textContent).toContain("pelo terminal");
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });
});

describe("6.2 avisos com ação", () => {
  test("each warning offers the action that resolves it", () => {
    const { calls, actions } = recorder();
    render(
      <ApplyPanel
        state={state([task("1.1", "pendente")])}
        warnings={[
          { member: "legado", kind: "sem-git" },
          { member: "repo-api", kind: "alteracoes-pendentes" },
        ]}
        busy={false}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inicializar Git" }));
    fireEvent.click(screen.getByRole("button", { name: "Commitar pendências" }));
    expect(calls).toEqual([
      ["resolve", { member: "legado", kind: "sem-git" }],
      ["resolve", { member: "repo-api", kind: "alteracoes-pendentes" }],
    ]);
  });
});
