import { describe, expect, test } from "bun:test";
import { TOKEN_HEADER, type RunView, type ServerEvent } from "@studio/shared";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events.ts";
import { createToken } from "../security.ts";
import { FakeEngine } from "../testing/fake-engine.ts";
import { AgentRunner, classifyError } from "./runner.ts";
import { ChangeSessions } from "./sessions.ts";
import { EngineStatusService } from "./status.ts";

function setup() {
  const db = openDatabase(":memory:");
  db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/repo', NULL, 'now')");
  const engine = new FakeEngine();
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const sessions = new ChangeSessions(db, engine);
  const runner = new AgentRunner(engine, sessions, events);
  return { engine, events, seen, sessions, runner };
}

const req = { workspaceId: "w", change: "add-export", directory: "/repo", text: "escreva a proposal" };

describe("AgentRunner streaming (6.4)", () => {
  test("accumulates text, tools and files and publishes each update", async () => {
    const { engine, seen, runner } = setup();
    const handle = await runner.start(req);
    const s = handle.run.sessionId;
    expect(engine.prompts[0]).toMatchObject({ sessionId: s, text: "escreva a proposal", opts: { directory: "/repo" } });

    engine.emit({ kind: "text", sessionId: s, partId: "p1", delta: "Vou escrever " });
    engine.emit({ kind: "text", sessionId: s, partId: "p1", delta: "a proposal." });
    engine.emit({ kind: "tool", sessionId: s, callId: "c1", tool: "write", status: "running", title: "proposal.md" });
    engine.emit({ kind: "tool", sessionId: s, callId: "c1", tool: "write", status: "completed", title: "proposal.md" });
    engine.emit({ kind: "file", directory: "/repo", path: "/repo/openspec/changes/add-export/proposal.md" });
    engine.emit({ kind: "file", directory: "/elsewhere", path: "/elsewhere/x.md" });
    engine.emit({ kind: "text", sessionId: "ses_other", partId: "px", delta: "not mine" });

    const view = runner.view("w", "add-export")!;
    expect(view.status).toBe("rodando");
    expect(view.transcript).toEqual([{ partId: "p1", text: "Vou escrever a proposal." }]);
    expect(view.tools).toEqual([{ callId: "c1", tool: "write", status: "completed", title: "proposal.md" }]);
    expect(view.files).toEqual(["/repo/openspec/changes/add-export/proposal.md"]);

    const updates = seen.filter((e) => e.type === "run-updated");
    expect(updates.length).toBeGreaterThanOrEqual(5);
    expect(updates.every((e) => e.type === "run-updated" && e.change === "add-export")).toBe(true);

    engine.emit({ kind: "idle", sessionId: s });
    expect((await handle.done).status).toBe("concluido");
  });

  test("questions the agent asked are kept on the run (6.9)", async () => {
    const { engine, runner } = setup();
    const handle = await runner.start(req);
    const s = handle.run.sessionId;
    engine.emit({ kind: "question", sessionId: s, questions: ["Qual banco?"] });
    engine.emit({ kind: "question", sessionId: s, questions: ["Precisa de login?"] });
    engine.emit({ kind: "question", sessionId: "ses_other", questions: ["not mine"] });
    engine.emit({ kind: "idle", sessionId: s });
    expect((await handle.done).questions).toEqual(["Qual banco?", "Precisa de login?"]);
  });

  test("one run at a time per change", async () => {
    const { runner } = setup();
    await runner.start(req);
    await expect(runner.start(req)).rejects.toThrow("already working");
    await runner.start({ ...req, change: "other" });
  });
});

describe("AgentRunner cancel and errors (6.5)", () => {
  test("Cancelamento: parar aborts the session and the run ends cancelado, not concluido", async () => {
    const { engine, runner } = setup();
    const handle = await runner.start(req);
    const view = await runner.cancel("w", "add-export");
    expect(engine.aborted).toEqual([handle.run.sessionId]);
    expect(view?.status).toBe("cancelado");
    // Late events after the abort do not flip the outcome.
    engine.emit({ kind: "error", sessionId: handle.run.sessionId, name: "MessageAbortedError", message: "aborted" });
    engine.emit({ kind: "idle", sessionId: handle.run.sessionId });
    expect((await handle.done).status).toBe("cancelado");
  });

  test("Erro do provedor: auth error fails the run with a clear message", async () => {
    const { engine, runner } = setup();
    const handle = await runner.start(req);
    engine.emit({ kind: "error", sessionId: handle.run.sessionId, name: "ProviderAuthError", message: "invalid x-api-key" });
    const done = await handle.done;
    expect(done.status).toBe("falhou");
    expect(done.error).toEqual({ kind: "autenticacao", message: "Falha de autenticação no provedor de LLM: invalid x-api-key" });
    // An idle after the error does not turn it into concluido.
    engine.emit({ kind: "idle", sessionId: handle.run.sessionId });
    expect(runner.view("w", "add-export")?.status).toBe("falhou");
  });

  test("rate limits and lost connections are classified", () => {
    expect(classifyError("APIError", "429 Too Many Requests").kind).toBe("limite");
    expect(classifyError("APIError", "rate_limit_error: slow down").kind).toBe("limite");
    expect(classifyError("PromptError", "fetch failed: ECONNREFUSED").kind).toBe("conexao");
    expect(classifyError("UnknownError", "boom").kind).toBe("outro");
  });

  test("a prompt the engine cannot accept fails the run", async () => {
    const { engine, runner } = setup();
    engine.onPrompt = () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };
    const done = await (await runner.start(req)).done;
    expect(done.status).toBe("falhou");
    expect(done.error?.kind).toBe("conexao");
  });

  test("an engine crash fails running runs as interrupted", async () => {
    const { engine, runner } = setup();
    const handle = await runner.start(req);
    engine.emit({ kind: "interrupted" });
    expect((await handle.done).error?.kind).toBe("interrompido");
  });

  test("a resumed change whose session the engine lost reports historyLost", async () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/repo', NULL, 'now')");
    const before = new FakeEngine();
    const first = await new AgentRunner(before, new ChangeSessions(db, before), new EventBus()).start(req);
    expect(first.historyLost).toBe(false);

    // Same database, but an engine that no longer knows the stored session.
    const after = new FakeEngine();
    const resumed = await new AgentRunner(after, new ChangeSessions(db, after), new EventBus()).start(req);
    expect(resumed.historyLost).toBe(true);
    expect(resumed.run.sessionId).not.toBe(first.run.sessionId);
  });
});

describe("run routes", () => {
  test("GET run returns the live view and POST cancel stops it", async () => {
    const { engine, runner } = setup();
    const token = createToken();
    const app = createApp({
      token,
      allowedOrigins: [],
      events: new EventBus(),
      engineStatus: new EngineStatusService(engine, new EventBus()),
      runner,
    });
    const call = async (method: string, path: string) =>
      (await app.request(`/api${path}`, { method, headers: { [TOKEN_HEADER]: token } })).json() as Promise<RunView | null>;

    expect(await call("GET", "/workspaces/w/changes/add-export/run")).toBeNull();
    await runner.start(req);
    expect((await call("GET", "/workspaces/w/changes/add-export/run"))?.status).toBe("rodando");
    expect((await call("POST", "/workspaces/w/changes/add-export/run/cancel"))?.status).toBe("cancelado");
    expect((await call("GET", "/workspaces/w/changes/add-export/run"))?.status).toBe("cancelado");
  });
});
