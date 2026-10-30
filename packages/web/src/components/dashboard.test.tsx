import { afterEach, describe, expect, test } from "bun:test";
import type { ArtifactStatus, ChangeStatus, SpecDetail, TaskChecklist, ValidationReport } from "@studio/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ArtifactGraph, layers } from "./ArtifactGraph.tsx";
import { ArtifactViewer } from "./ArtifactViewer.tsx";
import { ChangeList } from "./ChangeList.tsx";
import { CliBanner } from "./CliBanner.tsx";
import { SpecList } from "./SpecList.tsx";
import { SpecView } from "./SpecView.tsx";
import { TaskList } from "./TaskList.tsx";
import { ValidationPanel } from "./ValidationPanel.tsx";

afterEach(cleanup);

// Artifacts exactly as `openspec status --change add-export --json` reports them (OpenSpec 1.15).
const STATUS: Pick<ChangeStatus, "artifacts"> = {
  artifacts: [
    { id: "proposal", outputPath: "proposal.md", status: "done", requires: [] },
    { id: "specs", outputPath: "specs/**/*.md", status: "ready", requires: ["proposal"] },
    { id: "design", outputPath: "design.md", status: "ready", requires: ["proposal"] },
    { id: "tasks", outputPath: "tasks.md", status: "blocked", requires: ["specs", "design"], missingDeps: ["specs", "design"] },
  ],
};

describe("SpecList (5.3)", () => {
  test("Workspace com specs: lists ids, purposes and requirement counts", () => {
    render(
      <SpecList
        workspaceId="w"
        specs={[
          { id: "auth", purpose: "Login e sessão.", requirementCount: 3 },
          { id: "billing", purpose: "Cobrança.", requirementCount: 1 },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "auth" }).getAttribute("href")).toBe("/w/w/specs/auth");
    expect(screen.getByText("Login e sessão.")).toBeTruthy();
    expect(screen.getByText("3 requisitos")).toBeTruthy();
    expect(screen.getByText("1 requisito")).toBeTruthy();
  });

  test("Workspace sem specs: explains where specs come from", () => {
    render(<SpecList workspaceId="w" specs={[]} />);
    expect(screen.getByText(/archive|arquivada/).textContent).toContain("onboarding");
  });
});

describe("SpecView (5.3)", () => {
  test("Abrir spec: shows each requirement with its scenarios", () => {
    const spec: SpecDetail = {
      id: "auth",
      title: "auth",
      overview: "Autenticação.",
      requirementCount: 2,
      requirements: [
        {
          name: "Login",
          text: "The system SHALL reject expired tokens.",
          scenarios: [{ name: "Expired token", rawText: "- **WHEN** expired\n- **THEN** 401" }],
        },
        { name: "Logout", text: "The system SHALL end sessions.", scenarios: [] },
      ],
    };
    render(<SpecView spec={spec} />);
    expect(screen.getByRole("heading", { name: "Login" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cenário: Expired token" })).toBeTruthy();
    expect(screen.getByText("WHEN").tagName).toBe("STRONG");
    expect(screen.getByText("Sem cenários.")).toBeTruthy();
  });
});

describe("ChangeList (5.4)", () => {
  test("Changes em andamento: shows task progress", () => {
    render(
      <ChangeList
        workspaceId="w"
        changes={[{ name: "add-user-export", completedTasks: 3, totalTasks: 8, lastModified: "", status: "in-progress" }]}
      />,
    );
    expect(screen.getByRole("link", { name: "add-user-export" })).toBeTruthy();
    expect(screen.getByLabelText("3 de 8 tasks").textContent).toContain("3/8");
  });
});

describe("ArtifactGraph (5.4)", () => {
  test("lays artifacts out by dependency depth", () => {
    expect(layers(STATUS.artifacts).map((l) => l.map((a) => a.id))).toEqual([["proposal"], ["specs", "design"], ["tasks"]]);
  });

  test("Change parcialmente planejada: shows each artifact's state", () => {
    render(<ArtifactGraph artifacts={STATUS.artifacts} />);
    const state = (id: string) => screen.getByRole("button", { name: new RegExp(`^${id}`) }).getAttribute("data-state");
    expect(state("proposal")).toBe("done");
    expect(state("design")).toBe("ready");
    expect(state("specs")).toBe("ready");
    expect(state("tasks")).toBe("blocked");
    expect(screen.getByRole("button", { name: /^tasks/ }).getAttribute("title")).toBe("depende de: specs, design");
  });

  test("renders skipped artifacts and reports selection", () => {
    const artifacts: ArtifactStatus[] = [{ id: "specs", outputPath: "specs/**/*.md", status: "skipped", requires: [] }];
    let picked = "";
    render(<ArtifactGraph artifacts={artifacts} onSelect={(id) => (picked = id)} />);
    const node = screen.getByRole("button", { name: /specs/ });
    expect(within(node).getByText("ignorado")).toBeTruthy();
    fireEvent.click(node);
    expect(picked).toBe("specs");
  });
});

describe("ArtifactViewer (5.4)", () => {
  test("renders markdown and labels files of glob artifacts", () => {
    render(
      <ArtifactViewer
        files={[
          { path: "specs/auth/spec.md", content: "## ADDED Requirements" },
          { path: "specs/export/spec.md", content: "# Export" },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "ADDED Requirements" })).toBeTruthy();
    expect(screen.getByText("specs/export/spec.md")).toBeTruthy();
  });

  test("shows an empty state for an unwritten artifact", () => {
    render(<ArtifactViewer files={[]} />);
    expect(screen.getByText("Este artefato ainda não foi escrito.")).toBeTruthy();
  });
});

describe("TaskList (5.4)", () => {
  test("Abrir tasks: groups by section with done/pending marks", () => {
    const checklist: TaskChecklist = {
      total: 3,
      complete: 1,
      sections: [
        { title: "1. Setup", tasks: [{ id: "1.1", text: "Criar repo", done: true, line: 5 }] },
        {
          title: "2. Core",
          tasks: [
            { id: "2.1", text: "Fazer A", done: false, line: 9 },
            { id: null, text: "Sem número", done: false, line: 10 },
          ],
        },
      ],
    };
    render(<TaskList checklist={checklist} />);
    expect(screen.getByRole("heading", { name: "1. Setup" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "2. Core" })).toBeTruthy();
    expect(screen.getAllByLabelText("concluída")).toHaveLength(1);
    expect(screen.getAllByLabelText("pendente")).toHaveLength(2);
    expect(screen.getByText("Criar repo").closest("li")?.className).toContain("task-done");
  });
});

describe("ValidationPanel (5.5)", () => {
  test("Validação com erro: shows the error tied to the change and the affected file", () => {
    const report: ValidationReport = {
      items: [
        {
          id: "add-export",
          type: "change",
          valid: false,
          issues: [{ level: "ERROR", path: "export/spec.md", message: 'ADDED "Export CSV" must include at least one scenario' }],
        },
        { id: "auth", type: "spec", valid: true, issues: [] },
      ],
      summary: { totals: { items: 2, passed: 1, failed: 1 } },
    };
    render(<ValidationPanel report={report} />);
    expect(screen.getByText("1 com problemas, 1 válidos")).toBeTruthy();
    const item = screen.getByText("change add-export").closest("li")!;
    expect(within(item).getByText("export/spec.md")).toBeTruthy();
    expect(within(item).getByText(/must include at least one scenario/)).toBeTruthy();
    expect(screen.queryByText("spec auth")).toBeNull();
  });

  test("reports an all-valid result", () => {
    render(<ValidationPanel report={{ items: [], summary: { totals: { items: 3, passed: 3, failed: 0 } } }} />);
    expect(screen.getByText("Tudo válido (3)")).toBeTruthy();
  });
});

describe("CliBanner (5.5)", () => {
  test("CLI ausente: shows the warning with install instructions", () => {
    render(<CliBanner system={{ openspec: { available: false, message: "could not run 'openspec'" } }} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("CLI do OpenSpec indisponível");
    expect(alert.textContent).toContain("could not run 'openspec'");
    expect(within(alert).getByRole("link").getAttribute("href")).toBe("https://github.com/Fission-AI/OpenSpec");
  });

  test("renders nothing when the CLI is available", () => {
    const { container } = render(<CliBanner system={{ openspec: { available: true, version: "1.15.0" } }} />);
    expect(container.innerHTML).toBe("");
  });
});
