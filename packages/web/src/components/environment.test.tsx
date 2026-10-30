import { afterEach, describe, expect, test } from "bun:test";
import type { EnvironmentConfig, EnvironmentSettings, EnvironmentStatus } from "@studio/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EnvironmentChooser, EnvironmentStatusBox } from "./EnvironmentPanel.tsx";

afterEach(cleanup);

const images = [
  { id: "base", label: "Genérica (Debian)", image: "b" },
  { id: "node", label: "Node.js 22", image: "n" },
];

const settings = (extra: Partial<EnvironmentSettings> = {}): EnvironmentSettings => ({
  config: { mode: "local", idleMinutes: 30 },
  devcontainers: [],
  images,
  ...extra,
});

describe("4.1 escolha do ambiente", () => {
  test("Projeto com devcontainer: the member's devcontainer is offered and marked as suggested", () => {
    const saved: EnvironmentConfig[] = [];
    render(
      <EnvironmentChooser
        settings={settings({
          devcontainers: [{ member: "repo-api", path: "/w/repo-api/.devcontainer/devcontainer.json" }],
          suggested: "devcontainer:/w/repo-api/.devcontainer/devcontainer.json",
        })}
        saving={false}
        onSave={(c) => saved.push(c)}
      />,
    );
    const option = screen.getByLabelText(/Usar o devcontainer de repo-api/);
    expect(option.parentElement!.textContent).toContain("sugerida");
    fireEvent.click(option);
    fireEvent.change(screen.getByLabelText(/Parar o container depois de/), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar ambiente" }));
    expect(saved).toEqual([{ mode: "devcontainer:/w/repo-api/.devcontainer/devcontainer.json", idleMinutes: 45 }]);
  });

  test("Mais de um devcontainer: each member's is a separate choice", () => {
    render(
      <EnvironmentChooser
        settings={settings({
          devcontainers: [
            { member: "repo-api", path: "/a/.devcontainer/devcontainer.json" },
            { member: "repo-web", path: "/b/.devcontainer/devcontainer.json" },
          ],
        })}
        saving={false}
        onSave={() => {}}
      />,
    );
    expect(screen.getByLabelText(/Usar o devcontainer de repo-api/)).toBeTruthy();
    expect(screen.getByLabelText(/Usar o devcontainer de repo-web/)).toBeTruthy();
  });

  test("Projeto sem devcontainer: stock images and no container; the idle time is invalid below 1", () => {
    const saved: EnvironmentConfig[] = [];
    render(<EnvironmentChooser settings={settings()} saving={false} onSave={(c) => saved.push(c)} />);
    expect(screen.getByText(/Nenhum membro tem .devcontainer\/devcontainer.json/)).toBeTruthy();
    expect((screen.getByLabelText(/Sem container/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText(/Imagem padrão: Node.js 22/));
    fireEvent.change(screen.getByLabelText(/Parar o container depois de/), { target: { value: "0" } });
    expect((screen.getByRole("button", { name: "Salvar ambiente" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Parar o container depois de/), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar ambiente" }));
    expect(saved).toEqual([{ mode: "imagem:node", idleMinutes: 10 }]);
  });
});

describe("4.2 estado do ambiente no painel de apply", () => {
  const status = (extra: Partial<EnvironmentStatus>): EnvironmentStatus => ({ mode: "imagem:node", state: "pronto", output: [], ...extra });
  const handlers = () => {
    const calls: string[] = [];
    return {
      calls,
      props: { busy: false, onStop: () => calls.push("stop"), onRebuild: () => calls.push("rebuild"), onUseLocal: () => calls.push("local") },
    };
  };

  test("nothing is shown for a workspace without container", () => {
    const { props } = handlers();
    const { container } = render(<EnvironmentStatusBox status={status({ mode: "local", state: "ausente" })} {...props} />);
    expect(container.textContent).toBe("");
  });

  test("Primeira execução: preparing shows the progress output", () => {
    const { props } = handlers();
    render(<EnvironmentStatusBox status={status({ state: "preparando", output: ["Step 1/3", "Container started"] })} {...props} />);
    expect(screen.getByRole("status").textContent).toContain("Preparando o container");
    expect(screen.getByLabelText("Saída do preparo").textContent).toBe("Step 1/3\nContainer started");
    expect(screen.queryByRole("button", { name: "Reconstruir ambiente" })).toBeNull();
  });

  test("a ready container can be stopped and rebuilt", () => {
    const { calls, props } = handlers();
    render(<EnvironmentStatusBox status={status({})} {...props} />);
    expect(screen.getByRole("status").textContent).toContain("Container pronto");
    fireEvent.click(screen.getByRole("button", { name: "Parar ambiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconstruir ambiente" }));
    expect(calls).toEqual(["stop", "rebuild"]);
  });

  test("Reconstruir: a changed devcontainer.json suggests rebuilding", () => {
    const { props } = handlers();
    render(<EnvironmentStatusBox status={status({ mode: "devcontainer:/a/.devcontainer/devcontainer.json", needsRebuild: true })} {...props} />);
    expect(screen.getByText(/O devcontainer.json mudou desde o preparo/)).toBeTruthy();
  });

  test("Falha do ambiente: the error, the output, and the switch to no container", () => {
    const { calls, props } = handlers();
    render(
      <EnvironmentStatusBox
        status={status({ state: "falhou", error: "o Docker não está acessível nesta máquina", output: ["permission denied"] })}
        {...props}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("o Docker não está acessível");
    expect(screen.getByLabelText("Saída do preparo").textContent).toBe("permission denied");
    fireEvent.click(screen.getByRole("button", { name: "Rodar sem container" }));
    expect(calls).toEqual(["local"]);
  });

  test("a stopped container says it comes back on the next task; a UID mismatch is flagged", () => {
    const { props } = handlers();
    render(<EnvironmentStatusBox status={status({ state: "parado", uidMismatch: true })} {...props} />);
    expect(screen.getByRole("status").textContent).toContain("ele volta a subir na próxima task");
    expect(screen.getByText(/não ficou com o seu UID/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Parar ambiente" })).toBeNull();
  });
});
