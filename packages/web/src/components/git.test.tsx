import { afterEach, describe, expect, test } from "bun:test";
import type { GitArea, GitState, InitPreview } from "@studio/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitSection, InitDialog, PendingCommitDialog } from "./GitPanel.tsx";

afterEach(cleanup);

const area = (name: string, extra: Partial<GitArea> = {}): GitArea => ({
  name,
  path: `/w/${name}`,
  git: true,
  branch: "main",
  pending: 0,
  identity: { name: "Global", email: "g@x", nameScope: "global", emailScope: "global" },
  ...extra,
});

function recorder() {
  const calls: unknown[][] = [];
  return {
    calls,
    actions: {
      setIdentity: (a: GitArea, name: string, email: string) => calls.push(["identity", a.name, name, email]),
      clearIdentity: (a: GitArea) => calls.push(["clear", a.name]),
      open: (a: GitArea, dialog: "init" | "pending") => calls.push(["open", a.name, dialog]),
    },
  };
}

describe("6.3 seção Git do workspace", () => {
  const state: GitState = {
    busy: false,
    areas: [
      area("repo-api"),
      area("repo-web", { pending: 3, identity: { name: "Ana", email: "ana@empresa.com", nameScope: "local", emailScope: "local" } }),
      { name: "legado", path: "/w/legado", git: false, pending: 0, identity: {} },
    ],
  };

  test("Membros em estados diferentes: clean, pending and without Git, with each identity and its origin", () => {
    const { calls, actions } = recorder();
    render(<GitSection state={state} busy={false} actions={actions} />);
    expect(screen.getByText(/main · limpo/)).toBeTruthy();
    expect(screen.getByText(/3 alterações pendentes/)).toBeTruthy();
    expect(screen.getByText("sem Git")).toBeTruthy();
    expect(screen.getByLabelText("Identidade de repo-api").textContent).toContain("Global <g@x> (global)");
    expect(screen.getByLabelText("Identidade de repo-web").textContent).toContain("Ana <ana@empresa.com> (do repo)");
    fireEvent.click(screen.getByRole("button", { name: "Inicializar Git" }));
    fireEvent.click(screen.getByRole("button", { name: "Commitar pendências" }));
    fireEvent.click(screen.getByRole("button", { name: "Remover identidade do repo" }));
    expect(calls).toEqual([
      ["open", "legado", "init"],
      ["open", "repo-web", "pending"],
      ["clear", "repo-web"],
    ]);
  });

  test("Identidade própria do repo: the form saves the repo's own identity", () => {
    const { calls, actions } = recorder();
    render(<GitSection state={{ busy: false, areas: [area("repo-api")] }} busy={false} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Identidade própria" }));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@empresa.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar identidade do repo" }));
    expect(calls).toEqual([["identity", "repo-api", "Ana", "ana@empresa.com"]]);
    expect(screen.getByText(/configuração global do Git não é alterada/)).toBeTruthy();
  });

  test("Task aguardando revisão: Commitar pendências is unavailable, with the reason", () => {
    const { actions } = recorder();
    render(<GitSection state={{ busy: true, areas: [area("repo-web", { pending: 2 })] }} busy={false} actions={actions} />);
    expect((screen.getByRole("button", { name: "Commitar pendências" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/aceite ou desfaça a task antes/)).toBeTruthy();
  });
});

describe("6.3 inicializar Git", () => {
  const preview = (gitignore: string): InitPreview => ({
    gitignore,
    existing: false,
    additions: ["node_modules/", ".env"],
    files: [
      { path: ".gitignore", size: gitignore.length },
      { path: "src/a.ts", size: 2048 },
    ],
    fileCount: 2,
    totalBytes: gitignore.length + 2048,
    secrets: [{ path: ".env.local", ignored: !gitignore.includes("!.env.local") }],
  });

  test("Pré-visualização: the suggested .gitignore, the files, the secrets; editing recomputes it; one action only", async () => {
    const asked: (string | undefined)[] = [];
    const inits: unknown[][] = [];
    render(
      <InitDialog
        area={area("legado", { git: false })}
        busy={false}
        debounceMs={0}
        onPreview={async (g) => {
          asked.push(g);
          return preview(g ?? "node_modules/\n.env\n");
        }}
        onInit={(...args) => inits.push(args)}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => expect((screen.getByLabelText(".gitignore") as HTMLTextAreaElement).value).toBe("node_modules/\n.env\n"));
    expect(screen.getByText(/Vão entrar no commit inicial: 2 arquivos/)).toBeTruthy();
    expect(screen.getByText(/fica fora do commit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Só inicializar/ })).toBeNull();

    fireEvent.change(screen.getByLabelText(".gitignore"), { target: { value: "node_modules/\n.env\n!.env.local\n" } });
    await waitFor(() => expect(screen.getByText(/vai entrar no commit!/)).toBeTruthy());
    expect(asked).toEqual([undefined, "node_modules/\n.env\n!.env.local\n"]);

    fireEvent.click(screen.getByRole("button", { name: "Inicializar e fazer commit inicial" }));
    expect(inits).toEqual([["node_modules/\n.env\n!.env.local\n", "Estado inicial", false]]);
  });

  test("Pasta já dentro de um repo: the preview error blocks the action", async () => {
    render(
      <InitDialog
        area={area("x", { git: false })}
        busy={false}
        onPreview={async () => {
          throw new Error("/w/x já está dentro de um repositório Git");
        }}
        onInit={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(/já está dentro de um repositório Git/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Inicializar e fazer commit inicial" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("Sem identidade on the initial commit: the identity goes with the next init", async () => {
    const inits: unknown[][] = [];
    render(
      <InitDialog
        area={area("legado", { git: false })}
        busy={false}
        error={{ message: "o Git não sabe quem é o autor", git: { kind: "identidade", output: "" } }}
        onPreview={async () => preview(".env\n")}
        onInit={(...args) => inits.push(args)}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => expect((screen.getByLabelText(".gitignore") as HTMLTextAreaElement).value).toBe(".env\n"));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@x" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar identidade e tentar de novo" }));
    expect(inits).toEqual([[".env\n", "Estado inicial", false, { name: "Ana", email: "ana@x" }]]);
  });
});

describe("6.3 commitar pendências", () => {
  test("Limpar antes do apply: the count, a message, and the commit", () => {
    const commits: unknown[][] = [];
    render(<PendingCommitDialog area={area("repo-web", { pending: 3 })} busy={false} onCommit={(...a) => commits.push(a)} onCancel={() => {}} />);
    expect(screen.getByText(/3 arquivos alterados em/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Commitar pendências" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Mensagem do commit"), { target: { value: "ajustes manuais" } });
    fireEvent.click(button);
    expect(commits).toEqual([["ajustes manuais", false]]);
  });
});
