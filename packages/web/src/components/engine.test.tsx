import { afterEach, describe, expect, test } from "bun:test";
import type { EngineStatus } from "@studio/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiButton, EngineBanner } from "./EngineBanner.tsx";

afterEach(cleanup);

const status = (availability: EngineStatus["availability"], message?: string): EngineStatus => ({
  availability,
  version: "1.19.4",
  ...(message ? { message } : {}),
});

describe("EngineBanner (6.2)", () => {
  test("Motor não inicia: shows failed with the error and a retry", () => {
    let retried = false;
    render(<EngineBanner status={status("falhou", "spawn ENOENT")} onRetry={() => (retried = true)} />);
    expect(screen.getByRole("alert").textContent).toContain("spawn ENOENT");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(retried).toBe(true);
  });

  test("Nenhum provedor configurado: links to the Providers screen", () => {
    render(<EngineBanner status={status("sem_provedor")} />);
    expect(screen.getByRole("link", { name: "configurar um provedor" }).getAttribute("href")).toBe("/providers");
  });

  test("shows starting, and nothing when available", () => {
    render(<EngineBanner status={status("iniciando")} />);
    expect(screen.getByRole("status").textContent).toContain("Iniciando");
    cleanup();
    const { container } = render(<EngineBanner status={status("disponivel")} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("AiButton (6.2)", () => {
  test("is disabled with a reason unless the engine is available", () => {
    for (const [availability, reason] of [
      ["falhou", "O motor de IA não está disponível"],
      ["sem_provedor", "Configure um provedor de LLM para usar ações de IA"],
      ["iniciando", "O motor de IA ainda está iniciando"],
    ] as const) {
      render(<AiButton status={status(availability)}>Gerar</AiButton>);
      const button = screen.getByRole("button", { name: "Gerar" }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(reason);
      cleanup();
    }
  });

  test("Motor disponível: the action is enabled and clickable", () => {
    let clicked = false;
    render(
      <AiButton status={status("disponivel")} onClick={() => (clicked = true)}>
        Gerar
      </AiButton>,
    );
    const button = screen.getByRole("button", { name: "Gerar" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(clicked).toBe(true);
  });

  test("an unknown status (still loading) counts as starting", () => {
    render(<AiButton status={undefined}>Gerar</AiButton>);
    expect((screen.getByRole("button", { name: "Gerar" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
