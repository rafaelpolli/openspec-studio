import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOKEN_HEADER, type ProposalView, type RegisterWorkspaceResult, type RunView } from "@studio/shared";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { AgentRunner } from "../engine/runner.ts";
import { ChangeSessions } from "../engine/sessions.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createToken } from "../security.ts";
import { sandbox } from "../testing/fixture.ts";
import { INVALID_SPEC, promptArtifact, scriptedAgent, type ScriptOptions } from "../testing/scripted-agent.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import { ProposalService, suggestChangeName } from "./service.ts";

// Each proposal view runs `openspec status` and `openspec validate`; flows take a few seconds.
setDefaultTimeout(60_000);

const { dir, cli } = sandbox("studio-proposal-");
const adapter = new OpenSpecAdapter(cli);
const watcher = new WorkspaceWatcher(new EventBus());
afterAll(() => {
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
/** A fresh workspace and app with a scripted agent writing into the current change. */
async function setup(agent: Omit<ScriptOptions, "changeDir"> = {}) {
  const root = join(dir, `repo-${++counter}`);
  mkdirSync(root);
  await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), adapter, watcher);
  let current = "";
  const engine = scriptedAgent({ ...agent, changeDir: () => join(root, "openspec/changes", current) });
  const runner = new AgentRunner(engine, new ChangeSessions(db, engine), new EventBus());
  const proposals = new ProposalService(workspaces, adapter, runner, db);
  const token = createToken();
  const app = createApp({ token, allowedOrigins: [], events: new EventBus(), workspaces, proposals });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: any = await res.json();
    return { status: res.status, json };
  };
  const ws = ((await call("POST", "/workspaces", { kind: "mono", path: root })).json as RegisterWorkspaceResult).workspace.id;
  const create = async (name: string, description = "exportar dados do usuário em CSV") => {
    current = name;
    const res = await call("POST", `/workspaces/${ws}/changes`, { name, description });
    // The decisions checkpoint starts with the change (add-proposal-decisions); wait for it.
    await proposals.settled(ws, name);
    return res;
  };
  const base = (change: string) => `/workspaces/${ws}/changes/${change}`;
  const view = async (change: string) => (await call("GET", `${base(change)}/proposal`)).json as ProposalView;
  const states = async (change: string) => Object.fromEntries((await view(change)).artifacts.map((a) => [a.id, a.state]));
  /** Generates and waits for the run to finish. */
  const generate = async (change: string, artifact: string) => {
    const res = await call("POST", `${base(change)}/artifacts/${artifact}/generate`);
    await proposals.settled(ws, change);
    return res;
  };
  /** The prompts of the artifacts, without the decisions checkpoint's. */
  const prompts = () => engine.prompts.filter((p) => !/^# Decisões em aberto/m.test(p.text));
  return { root, ws, call, create, base, view, states, generate, engine, prompts, proposals, db };
}

describe("7.1 iniciar uma change", () => {
  test("suggests a kebab-case name from the description", async () => {
    expect(suggestChangeName("Exportar dados do usuário em CSV")).toBe("exportar-dados-usuario-csv");
    expect(suggestChangeName("Add user export!")).toBe("add-user-export");
    const { call } = await setup();
    expect((await call("GET", `/suggest-name?description=${encodeURIComponent("Ação de teste")}`)).json).toEqual({
      name: "acao-teste",
    });
  });

  test("Nova change: creates it in the workspace root with its artifact graph", async () => {
    const { create, states, root } = await setup();
    const res = await create("add-user-export");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ change: "add-user-export", description: "exportar dados do usuário em CSV" });
    expect(await states("add-user-export")).toEqual({
      proposal: "pronto",
      specs: "bloqueado",
      design: "bloqueado",
      tasks: "bloqueado",
    });
    expect(readFileSync(join(root, "openspec/changes/add-user-export/.openspec.yaml"), "utf8")).toContain("spec-driven");
  });

  test("Nome já existente: refused with a conflict; invalid names are rejected", async () => {
    const { create } = await setup();
    await create("add-user-export");
    const dup = await create("add-user-export");
    expect(dup.status).toBe(409);
    expect(dup.json.error.message).toContain("já existe uma change ativa chamada add-user-export");
    expect((await create("Add User Export")).status).toBe(400);
  });
});

describe("7.3 gerar artefato pronto + validar", () => {
  test("Artefato bloqueado: generating an artifact whose dependencies are not approved is refused", async () => {
    const { create, call, base } = await setup();
    await create("add-x");
    const res = await call("POST", `${base("add-x")}/artifacts/tasks/generate`);
    expect(res.status).toBe(409);
    expect(res.json.error.message).toBe("tasks depende de: specs, design");
  });

  test("generates the proposal with the instructions prompt, then it awaits approval", async () => {
    const { create, generate, states, prompts, root } = await setup();
    await create("add-x");
    const res = await generate("add-x", "proposal");
    expect(res.status).toBe(202);
    // The scripted agent may already have finished when the response is serialized.
    expect(["rodando", "concluido"]).toContain((res.json as RunView).status);
    expect(promptArtifact(prompts()[0]!.text)).toBe("proposal");
    expect(prompts()[0]!.text).toContain(join(root, "openspec/changes/add-x/proposal.md"));
    expect(prompts()[0]!.text).toContain("exportar dados do usuário em CSV");
    expect((await states("add-x")).proposal).toBe("aguardando_aprovacao");
  });

  test("Validação falha: an invalid spec shows the issue; the agent can be asked to fix it", async () => {
    const { create, generate, call, base, view } = await setup({ content: { specs: INVALID_SPEC } });
    await create("add-x");
    await generate("add-x", "proposal");
    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    await generate("add-x", "specs");

    const specs = (await view("add-x")).artifacts.find((a) => a.id === "specs")!;
    expect(specs.state).toBe("aguardando_aprovacao");
    expect(specs.issues).toEqual([
      { level: "ERROR", path: "export/spec.md", message: 'ADDED "Exportar CSV" must include at least one scenario' },
    ]);

    const fix = await call("POST", `${base("add-x")}/artifacts/specs/fix`);
    expect(fix.status).toBe(202);
    await (async () => {
      while ((await view("add-x")).generating) await Bun.sleep(10);
    })();
    expect((await view("add-x")).artifacts.find((a) => a.id === "specs")!.issues).toEqual([]);
  });

  test("an agent that finishes without writing leaves the artifact as it was, with a notice", async () => {
    const { create, generate, view } = await setup({ write: () => false });
    await create("add-x");
    await generate("add-x", "proposal");
    const v = await view("add-x");
    expect(v.artifacts.find((a) => a.id === "proposal")!.state).toBe("pronto");
    expect(v.notice).toBe("O agente terminou sem escrever proposal.");
  });
});

describe("7.4 aprovação", () => {
  test("approval unlocks dependents; editing after approval re-requests it; dependents become a revisar", async () => {
    const { create, generate, call, base, states, root } = await setup();
    await create("add-x");
    await generate("add-x", "proposal");
    expect((await call("POST", `${base("add-x")}/artifacts/specs/generate`)).status).toBe(409); // Sem aprovação
    expect((await call("POST", `${base("add-x")}/artifacts/proposal/approve`)).status).toBe(200);
    expect(await states("add-x")).toMatchObject({ proposal: "aprovado", specs: "pronto", design: "pronto" });

    await generate("add-x", "design");
    await call("POST", `${base("add-x")}/artifacts/design/approve`);
    expect((await states("add-x")).design).toBe("aprovado");

    // External edit of the proposal (e.g. in an editor) after design was approved.
    const proposal = join(root, "openspec/changes/add-x/proposal.md");
    writeFileSync(proposal, `${readFileSync(proposal, "utf8")}\nMais um parágrafo.\n`);
    expect(await states("add-x")).toMatchObject({ proposal: "aguardando_aprovacao", design: "a_revisar" });

    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    expect((await states("add-x")).design).toBe("a_revisar");
    await call("POST", `${base("add-x")}/artifacts/design/approve`);
    expect((await states("add-x")).design).toBe("aprovado");
  });

  test("approving something that is not awaiting approval is a conflict", async () => {
    const { create, call, base } = await setup();
    await create("add-x");
    expect((await call("POST", `${base("add-x")}/artifacts/proposal/approve`)).status).toBe(409);
  });
});

describe("7.5 edição manual e pedido de ajuste", () => {
  test("Edição salva: saving writes the file and the artifact awaits approval again", async () => {
    const { create, generate, call, base, states, root } = await setup();
    await create("add-x");
    await generate("add-x", "proposal");
    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    const res = await call("PUT", `${base("add-x")}/artifacts/proposal/content`, {
      path: "proposal.md",
      content: "# Proposal\n\n## Why\n\nTexto alterado pelo usuário.\n",
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, "openspec/changes/add-x/proposal.md"), "utf8")).toContain("Texto alterado pelo usuário.");
    expect((await states("add-x")).proposal).toBe("aguardando_aprovacao");
  });

  test("edits are limited to the artifact's own files", async () => {
    const { create, generate, call, base } = await setup();
    await create("add-x");
    await generate("add-x", "proposal");
    for (const path of ["design.md", "../../config.yaml", "/etc/passwd"]) {
      expect((await call("PUT", `${base("add-x")}/artifacts/proposal/content`, { path, content: "x" })).status).toBe(400);
    }
  });

  test("Ajuste solicitado: the request goes to the same session and the artifact awaits approval", async () => {
    const { create, generate, call, base, states, engine, prompts, proposals, ws } = await setup();
    await create("add-x");
    await generate("add-x", "proposal");
    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    const res = await call("POST", `${base("add-x")}/artifacts/proposal/adjust`, {
      request: "remova a parte de autenticação do escopo",
    });
    expect(res.status).toBe(202);
    await proposals.settled(ws, "add-x");
    const [first, adjust] = prompts();
    expect(adjust!.sessionId).toBe(first!.sessionId);
    expect(adjust!.text).toContain("remova a parte de autenticação do escopo");
    expect((await states("add-x")).proposal).toBe("aguardando_aprovacao");
  });
});

describe("7.6 gerar o resto automaticamente", () => {
  test("Geração completa: specs, design and tasks are generated in order and await approval", async () => {
    const { create, generate, call, base, view, proposals, ws, engine, prompts } = await setup();
    await create("add-x");
    await generate("add-x", "proposal");
    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    const res = await call("POST", `${base("add-x")}/generate-rest`);
    expect(res.status).toBe(202);
    expect((res.json as ProposalView).autoRunning).toBe(true);
    await proposals.settled(ws, "add-x");

    const v = await view("add-x");
    expect(Object.fromEntries(v.artifacts.map((a) => [a.id, a.state]))).toEqual({
      proposal: "aprovado",
      specs: "aguardando_aprovacao",
      design: "aguardando_aprovacao",
      tasks: "aguardando_aprovacao",
    });
    expect(prompts().map((p) => promptArtifact(p.text))).toEqual(["proposal", "specs", "design", "tasks"]);
    expect(v.notice).toBeNull();
    expect(v.autoRunning).toBe(false);
  });

  test("Erro no meio: a validation failure in specs stops before tasks", async () => {
    const { create, generate, call, base, view, proposals, ws, engine, prompts } = await setup({ content: { specs: INVALID_SPEC } });
    await create("add-x");
    await generate("add-x", "proposal");
    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    await call("POST", `${base("add-x")}/generate-rest`);
    await proposals.settled(ws, "add-x");

    const v = await view("add-x");
    expect(v.notice).toBe("Geração automática interrompida: specs tem erros de validação");
    expect(prompts().map((p) => promptArtifact(p.text))).toEqual(["proposal", "specs"]);
    expect(v.artifacts.find((a) => a.id === "tasks")!.state).toBe("bloqueado");
    expect(v.artifacts.find((a) => a.id === "specs")!.issues).toHaveLength(1);
  });

  test("a failed run also stops the chain, and the CLI sees the planned change", async () => {
    const { create, generate, call, base, view, proposals, ws, engine, prompts, root } = await setup();
    await create("add-x");
    await generate("add-x", "proposal");
    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    engine.onPrompt = (c, e) => e.emit({ kind: "error", sessionId: c.sessionId, name: "ProviderAuthError", message: "bad key" });
    await call("POST", `${base("add-x")}/generate-rest`);
    await proposals.settled(ws, "add-x");
    expect((await view("add-x")).notice).toBe(
      "Geração automática interrompida em specs: Falha de autenticação no provedor de LLM: bad key",
    );
    // Artefatos ficam no formato OpenSpec: the terminal CLI recognizes the change.
    const status = await new OpenSpecAdapter(cli).status({ cwd: root }, "add-x");
    expect(status.artifacts.find((a) => a.id === "proposal")?.status).toBe("done");
  });
});

const DECISIONS = [
  { id: "campos", question: "Quais campos entram no CSV?", why: "privacidade", options: [{ label: "Todos" }, { label: "Só nome e e-mail" }], recommended: 1 },
  { id: "formato-data", question: "Formato da data?", options: [{ label: "ISO 8601" }, { label: "dd/mm/aaaa" }], recommended: 0 },
];

describe("2.2 checkpoint de decisões (add-proposal-decisions)", () => {
  test("Decisões levantadas: the proposal waits for them; generating it is refused", async () => {
    const { create, view, call, base, prompts, engine } = await setup({ decisions: DECISIONS });
    await create("add-x");
    const v = await view("add-x");
    expect(v.decisions).toMatchObject({ status: "aguardando", decisions: DECISIONS, answers: [] });
    expect(v.artifacts.find((a) => a.id === "proposal")).toMatchObject({ state: "bloqueado", waitingOn: ["decisões"] });
    const refused = await call("POST", `${base("add-x")}/artifacts/proposal/generate`);
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toBe("responda ou pule as decisões antes de gerar proposal");
    expect(engine.prompts[0]!.text).toStartWith("# Decisões em aberto da change `add-x`");
    expect(prompts()).toHaveLength(0);
  });

  test("Pular: the proposal is available and its prompt has no decisions", async () => {
    const { create, call, base, view, generate, prompts, root } = await setup({ decisions: DECISIONS });
    await create("add-x");
    const res = await call("POST", `${base("add-x")}/decisions/skip`);
    expect(res.status).toBe(200);
    expect((res.json as ProposalView).decisions?.status).toBe("pulado");
    expect((await view("add-x")).artifacts.find((a) => a.id === "proposal")!.state).toBe("pronto");
    await generate("add-x", "proposal");
    expect(prompts()[0]!.text).not.toContain("Decisões do usuário");
    expect(readFileSync(join(root, "openspec/changes/add-x/decisions.md"), "utf8")).toContain("- Checkpoint: pulado pelo usuário");
  });

  test("Nenhuma decisão: answered at once, and the proposal is available", async () => {
    const { create, view } = await setup();
    await create("add-x");
    const v = await view("add-x");
    expect(v.decisions).toMatchObject({ status: "respondido", decisions: [] });
    expect(v.artifacts.find((a) => a.id === "proposal")!.state).toBe("pronto");
  });

  test("Falha do agente: the error shows; Tentar de novo raises them again; a missing file is a failure too", async () => {
    let answer: unknown[] | "fail" | "none" = "fail";
    const { create, view, call, base, proposals, ws } = await setup({ decisions: () => answer });
    await create("add-x");
    let v = await view("add-x");
    expect(v.decisions?.status).toBe("falhou");
    expect(v.decisions?.error).toContain("sem chave");
    expect(v.artifacts.find((a) => a.id === "proposal")!.state).toBe("bloqueado");
    answer = "none";
    expect((await call("POST", `${base("add-x")}/decisions/retry`)).status).toBe(202);
    await proposals.settled(ws, "add-x");
    expect((await view("add-x")).decisions).toMatchObject({ status: "falhou", error: "o agente terminou sem escrever a lista de decisões" });
    answer = DECISIONS;
    await call("POST", `${base("add-x")}/decisions/retry`);
    await proposals.settled(ws, "add-x");
    v = await view("add-x");
    expect(v.decisions?.status).toBe("aguardando");
    expect((await call("POST", `${base("add-x")}/decisions/retry`)).status).toBe(409);
  });

  test("Parada no checkpoint: gerar o resto waits, then generates everything after the answers", async () => {
    const { create, call, base, view, proposals, ws, prompts } = await setup({ decisions: DECISIONS });
    await create("add-x");
    const waiting = (await call("POST", `${base("add-x")}/generate-rest`)).json as ProposalView;
    expect(waiting.notice).toBe("A geração continua depois que você responder às decisões.");
    expect(waiting.decisions?.resumeAuto).toBe(true);
    expect(prompts()).toHaveLength(0);
    const answered = await call("POST", `${base("add-x")}/decisions/answers`, {
      answers: [
        { id: "campos", kind: "propria", text: "só nome e e-mail" },
        { id: "formato-data", kind: "recomendada" },
      ],
    });
    expect(answered.status).toBe(200);
    await proposals.settled(ws, "add-x");
    const v = await view("add-x");
    expect(prompts().map((p) => promptArtifact(p.text))).toEqual(["proposal", "specs", "design", "tasks"]);
    expect(v.artifacts.every((a) => a.state === "aguardando_aprovacao")).toBe(true);
    expect(v.decisions?.resumeAuto).toBe(false);
  });

  test("a change without a checkpoint (from before this change) works as before", async () => {
    const { create, view, db, ws } = await setup({ decisions: DECISIONS });
    await create("add-x");
    db.run("DELETE FROM change_decisions WHERE workspace_id = ? AND change_name = 'add-x'", [ws]);
    const v = await view("add-x");
    expect(v.decisions).toBeNull();
    expect(v.artifacts.find((a) => a.id === "proposal")!.state).toBe("pronto");
  });
});

describe("2.3 rotas das decisões", () => {
  test("answers: 400 when incomplete, an unknown option or empty own text; 409 out of state", async () => {
    const { create, call, base } = await setup({ decisions: DECISIONS });
    await create("add-x");
    const post = (answers: unknown) => call("POST", `${base("add-x")}/decisions/answers`, { answers });
    let res = await post([{ id: "campos", kind: "recomendada" }]);
    expect([res.status, res.json.error.message]).toEqual([400, "responda todas as decisões (faltam: formato-data)"]);
    res = await post([{ id: "campos", kind: "opcao", option: 5 }, { id: "formato-data", kind: "recomendada" }]);
    expect([res.status, res.json.error.message]).toEqual([400, "opção inválida para campos"]);
    expect((await post([{ id: "campos", kind: "propria", text: " " }, { id: "formato-data", kind: "recomendada" }])).status).toBe(400);
    expect((await post([{ id: "x", kind: "recomendada" }])).status).toBe(400);
    res = await post([{ id: "campos", kind: "opcao", option: 0 }, { id: "formato-data", kind: "recomendada" }]);
    expect(res.status).toBe(200);
    expect((res.json as ProposalView).decisions).toMatchObject({ status: "respondido", answers: [{ id: "campos", kind: "opcao", option: 0 }, { id: "formato-data", kind: "recomendada" }] });
    expect((await call("POST", `${base("add-x")}/decisions/skip`)).status).toBe(409);
  });
});

describe("3.2 suposições de cada geração", () => {
  test("Suposição mostrada: the agent's list and its unanswered questions are the artifact's assumptions; the files stay clean", async () => {
    const { create, generate, view, root } = await setup({
      assumptions: { proposal: [{ text: "o export roda em segundo plano para arquivos grandes" }] },
      questions: { proposal: ["Qual o limite de linhas do CSV?"] },
    });
    await create("add-x");
    await generate("add-x", "proposal");
    const proposal = (await view("add-x")).artifacts.find((a) => a.id === "proposal")!;
    expect(proposal.assumptions).toEqual([
      { text: "o export roda em segundo plano para arquivos grandes" },
      { text: "o agente seguiu sem resposta e registrou a escolha no artefato", question: "Qual o limite de linhas do CSV?" },
    ]);
    const dir = join(root, "openspec/changes/add-x");
    expect(readFileSync(join(dir, "proposal.md"), "utf8")).not.toContain("segundo plano");
    expect(existsSync(join(dir, ".studio"))).toBe(false);
  });

  test("a question the agent already listed is not repeated; no list means no assumptions", async () => {
    const { create, generate, view } = await setup({
      assumptions: { proposal: [{ text: "até 10 mil linhas", question: "Qual o limite de linhas do CSV?" }] },
      questions: { proposal: ["Qual o limite de linhas do CSV?"] },
    });
    await create("add-x");
    await generate("add-x", "proposal");
    const artifacts = (await view("add-x")).artifacts;
    expect(artifacts.find((a) => a.id === "proposal")!.assumptions).toEqual([{ text: "até 10 mil linhas", question: "Qual o limite de linhas do CSV?" }]);
    expect(artifacts.find((a) => a.id === "specs")!.assumptions).toBeUndefined();
  });

  test("an adjustment replaces the assumptions with the new ones", async () => {
    let round = 0;
    const { create, generate, call, base, view, proposals, ws } = await setup({
      assumptions: { get proposal() { return [{ text: `suposição ${++round}` }]; } } as never,
    });
    await create("add-x");
    await generate("add-x", "proposal");
    await call("POST", `${base("add-x")}/artifacts/proposal/adjust`, { request: 'Sobre a suposição "suposição 1": não' });
    await proposals.settled(ws, "add-x");
    expect((await view("add-x")).artifacts.find((a) => a.id === "proposal")!.assumptions).toEqual([{ text: "suposição 2" }]);
  });
});

describe("3.3 a revisar por decisões", () => {
  test("editing an answer sends the generated proposal and design to a revisar; regenerating clears it", async () => {
    const { create, generate, call, base, view, proposals, ws } = await setup({ decisions: DECISIONS });
    await create("add-x");
    const answer = (formato: number) =>
      call("POST", `${base("add-x")}/decisions/answers`, {
        answers: [{ id: "campos", kind: "recomendada" }, { id: "formato-data", kind: "opcao", option: formato }],
      });
    await answer(0);
    await generate("add-x", "proposal");
    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    await generate("add-x", "design");
    await answer(1);
    let v = await view("add-x");
    expect(v.artifacts.filter((a) => a.staleDecisions).map((a) => [a.id, a.state])).toEqual([
      ["proposal", "a_revisar"],
      ["design", "a_revisar"],
    ]);
    await call("POST", `${base("add-x")}/artifacts/design/adjust`, { request: "use dd/mm/aaaa" });
    await proposals.settled(ws, "add-x");
    v = await view("add-x");
    expect(v.artifacts.find((a) => a.id === "design")!.staleDecisions).toBeUndefined();
    expect(v.artifacts.find((a) => a.id === "proposal")!.staleDecisions).toBe(true);
  });
});

describe("4.1 decisions.md", () => {
  test("Arquivo gravado: each decision with its answer and origin; Aprovação registra the accepted assumptions; validate still passes", async () => {
    const { create, generate, call, base, root } = await setup({
      decisions: DECISIONS,
      assumptions: { proposal: [{ text: "o export roda em segundo plano" }, { text: "até 10 mil linhas", question: "Qual o limite?" }] },
    });
    await create("add-x");
    await call("POST", `${base("add-x")}/decisions/answers`, {
      answers: [{ id: "campos", kind: "propria", text: "só o e-mail" }, { id: "formato-data", kind: "recomendada" }],
    });
    const file = join(root, "openspec/changes/add-x/decisions.md");
    let md = readFileSync(file, "utf8");
    expect(md).toStartWith("# Decisões: add-x\n\n- Checkpoint: respondido\n\n## Decisões\n\n### Quais campos entram no CSV?\n\nprivacidade\n\n");
    expect(md).toContain("- Opções: Todos; Só nome e e-mail (recomendada)\n- Resposta: só o e-mail (resposta própria)");
    expect(md).toContain("- Resposta: ISO 8601 (recomendada)");
    expect(md).not.toContain("Suposições aceitas");
    await generate("add-x", "proposal");
    expect(readFileSync(file, "utf8")).not.toContain("Suposições aceitas"); // not approved yet
    await call("POST", `${base("add-x")}/artifacts/proposal/approve`);
    md = readFileSync(file, "utf8");
    expect(md).toContain("## Suposições aceitas\n\n### proposal\n\n- o export roda em segundo plano\n- até 10 mil linhas (pergunta do agente: Qual o limite?)\n");
    // The record lives next to the artifacts without getting in the way of OpenSpec.
    await generate("add-x", "specs");
    const strict = await cli.run(["validate", "add-x", "--strict"], { cwd: root });
    expect([strict.exitCode, `${strict.stdout}${strict.stderr}`.includes("decisions.md")]).toEqual([0, false]);
    const status = await adapter.status({ cwd: root }, "add-x");
    expect(status.artifacts.find((a) => a.id === "proposal")!.status).toBe("done");
  });

  test("Nenhuma decisão: the file says there was nothing to decide", async () => {
    const { create, root } = await setup();
    await create("add-x");
    expect(readFileSync(join(root, "openspec/changes/add-x/decisions.md"), "utf8")).toBe("# Decisões: add-x\n\n- Checkpoint: sem decisões a tomar\n");
  });
});

describe("3.1 decisões vindas da exploração (add-workspace-explore D5)", () => {
  const TAKEN = [
    { question: "Nível de prova", answer: "B+C como base" },
    { question: "Archive na UI", answer: "com portão" },
  ];
  async function createFrom(setupOpts: Parameters<typeof setup>[0]) {
    const t = await setup(setupOpts);
    const ws = t.ws;
    await t.proposals.create(ws, "add-x", "verificar changes", { decisions: TAKEN });
    await t.proposals.settled(ws, "add-x");
    return t;
  }

  test("Nada em aberto: answered with the exploration's decisions; the proposal is available", async () => {
    const t = await createFrom({});
    const v = await t.view("add-x");
    expect(v.decisions).toMatchObject({ status: "respondido", answers: [{ id: "exploracao-1", kind: "recomendada" }, { id: "exploracao-2", kind: "recomendada" }] });
    expect(v.decisions!.decisions.map((d) => [d.question, d.options[0]!.label, d.source])).toEqual([
      ["Nível de prova", "B+C como base", "exploracao"],
      ["Archive na UI", "com portão", "exploracao"],
    ]);
    expect(v.artifacts.find((a) => a.id === "proposal")!.state).toBe("pronto");
    const checkpointPrompt = t.engine.prompts[0]!.text;
    expect(checkpointPrompt).toContain("## Decisões já tomadas na exploração (não repita)\n\n- Nível de prova → B+C como base\n- Archive na UI → com portão");
    expect(readFileSync(join(t.root, "openspec/changes/add-x/decisions.md"), "utf8")).toContain("- Resposta: B+C como base (da exploração)");
  });

  test("Só as novas: the agent's new decision waits, after the exploration's, which stay answered", async () => {
    const t = await createFrom({ decisions: [DECISIONS[0]!] });
    const v = await t.view("add-x");
    expect(v.decisions!.status).toBe("aguardando");
    expect(v.decisions!.decisions.map((d) => d.id)).toEqual(["exploracao-1", "exploracao-2", "campos"]);
    expect(v.decisions!.answers.map((a) => a.id)).toEqual(["exploracao-1", "exploracao-2"]);
    // Answering keeps the exploration's answers and adds the new one; editing one makes it the user's.
    const res = await t.call("POST", `${t.base("add-x")}/decisions/answers`, {
      answers: [{ id: "exploracao-1", kind: "propria", text: "só B" }, { id: "exploracao-2", kind: "recomendada" }, { id: "campos", kind: "recomendada" }],
    });
    expect(res.status).toBe(200);
    const md = readFileSync(join(t.root, "openspec/changes/add-x/decisions.md"), "utf8");
    expect(md).toContain("- Resposta: só B (resposta própria)");
    expect(md).toContain("- Resposta: com portão (da exploração)");
  });

  test("a change without an exploration has no such section in the checkpoint prompt", async () => {
    const t = await setup({});
    await t.create("add-y");
    expect(t.engine.prompts[0]!.text).not.toContain("Decisões já tomadas na exploração");
  });
});
