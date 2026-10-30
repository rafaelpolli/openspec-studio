import { afterEach, describe, expect, test } from "bun:test";
import type { RunView } from "@studio/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentStream } from "./AgentStream.tsx";

afterEach(cleanup);

const base: RunView = {
  runId: "r",
  sessionId: "s",
  status: "rodando",
  startedAt: "2026-10-27T10:00:00Z",
  transcript: [],
  tools: [],
  files: [],
};

describe("AgentStream (6.4 / 6.5)", () => {
  test("Geração em andamento: shows the text as produced and the file being written", () => {
    render(
      <AgentStream
        run={{
          ...base,
          transcript: [{ partId: "p1", text: "Escrevendo a **proposal**" }],
          tools: [{ callId: "c", tool: "write", status: "running", title: "proposal.md" }],
          files: ["/repo/openspec/changes/add-export/proposal.md"],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Agente trabalhando…");
    expect(screen.getByText("proposal").tagName).toBe("STRONG");
    expect(screen.getByText(/write: proposal.md/)).toBeTruthy();
    expect(screen.getByText("openspec/changes/add-export/proposal.md")).toBeTruthy();
  });

  test("lists the questions the agent asked and that nobody answered them (6.9)", () => {
    render(<AgentStream run={{ ...base, status: "concluido", questions: ["Qual banco de dados usar?"] }} />);
    expect(screen.getByRole("heading", { name: "Perguntas do agente" })).toBeTruthy();
    expect(screen.getByText("Qual banco de dados usar?")).toBeTruthy();
    expect(screen.getByText(/o agente seguiu com a opção mais razoável/)).toBeTruthy();
  });

  test("Cancelamento: Parar is offered while running and calls cancel", () => {
    let cancelled = false;
    render(<AgentStream run={base} onCancel={() => (cancelled = true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    expect(cancelled).toBe(true);
  });

  test("a cancelled run says the step is incomplete and offers no Parar", () => {
    render(<AgentStream run={{ ...base, status: "cancelado" }} onCancel={() => {}} />);
    expect(screen.getByText("A etapa ficou incompleta.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Parar" })).toBeNull();
  });

  test("Erro do provedor: shows the error message", () => {
    render(
      <AgentStream
        run={{ ...base, status: "falhou", error: { kind: "autenticacao", message: "Falha de autenticação no provedor de LLM: bad key" } }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Falhou");
    expect(screen.getByRole("alert").textContent).toBe("Falha de autenticação no provedor de LLM: bad key");
  });
});
