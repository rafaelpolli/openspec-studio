import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@studio/shared";
import { openDatabase } from "../db.ts";
import { AgentRunner } from "../engine/runner.ts";
import { ChangeSessions } from "../engine/sessions.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { ProposalService } from "../proposal/service.ts";
import { FakeEngine, type PromptCall } from "../testing/fake-engine.ts";
import { sandbox } from "../testing/fixture.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import { ExplorationRepo } from "./repo.ts";
import { ExplorationService } from "./service.ts";

export interface AgentScript {
  /** The answer to a conversation message; "hang" never finishes, "fail" errors. */
  answer?: (call: PromptCall) => string | "hang" | "fail";
  /** The title written on the first answer; undefined writes none. */
  title?: string;
  /** The draft JSON the agent writes on "Virar change" (or raw text). */
  draft?: unknown;
  /** Something the agent writes into the member while answering, to test the guard. */
  writeMember?: string;
}

/**
 * A mono-repo workspace with OpenSpec, an exploration service and a proposal service on a
 * scripted agent: conversation prompts get `answer`, the first one writes `title`, and the
 * draft prompt writes `draft`.
 */
export async function explorationSetup(script: AgentScript = {}) {
  const { dir, cli } = sandbox("studio-explore-");
  const adapter = new OpenSpecAdapter(cli);
  const watcher = new WorkspaceWatcher(new EventBus());
  const db = openDatabase(":memory:");
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), adapter, watcher);
  const root = join(dir, "app");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
  const ws = (await workspaces.register({ kind: "mono", path: root })).workspace;

  const engine = new FakeEngine();
  engine.abort = async (sessionId) => {
    engine.aborted.push(sessionId);
    engine.emit({ kind: "text", sessionId, partId: "parcial", delta: "" });
    engine.emit({ kind: "error", sessionId, name: "MessageAbortedError", message: "aborted" });
  };
  engine.onPrompt = async (call, e) => {
    await Bun.sleep(5);
    if (/^# Virar change/m.test(call.text)) {
      const file = /escreva apenas o arquivo `([^`]+)`/.exec(call.text)?.[1];
      if (file && script.draft !== undefined) writeFileSync(file, typeof script.draft === "string" ? script.draft : JSON.stringify(script.draft));
      return e.emit({ kind: "idle", sessionId: call.sessionId });
    }
    if (/^# Decisões em aberto/m.test(call.text)) {
      const file = /Escreva apenas o arquivo `([^`]+)`/.exec(call.text)?.[1];
      if (file) {
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, JSON.stringify({ decisions: [] }));
      }
      return e.emit({ kind: "idle", sessionId: call.sessionId });
    }
    const answer = script.answer?.(call) ?? `resposta a: ${call.text.split("\n").at(-1)}`;
    if (answer === "fail") return e.emit({ kind: "error", sessionId: call.sessionId, name: "ProviderAuthError", message: "sem chave" });
    e.emit({ kind: "text", sessionId: call.sessionId, partId: `p${engine.prompts.length}`, delta: answer === "hang" ? "começo da resposta" : answer });
    if (answer === "hang") return;
    const titleFile = /escreva em `([^`]+)` um título curto/.exec(call.text)?.[1];
    if (titleFile && script.title) writeFileSync(titleFile, `${script.title}\n`);
    if (script.writeMember) writeFileSync(join(root, "src", "a.ts"), script.writeMember);
    e.emit({ kind: "idle", sessionId: call.sessionId });
  };
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe((ev) => void seen.push(ev));
  const runner = new AgentRunner(engine, new ChangeSessions(db, engine), events);
  const proposals = new ProposalService(workspaces, adapter, runner, db);
  const repo = new ExplorationRepo(db);
  const service = new ExplorationService(workspaces, runner, repo, events, {
    workDir: mkdtempSync(join(tmpdir(), "studio-explore-work-")),
    context: async () => ({ specs: [{ id: "workspaces", purpose: "Registrar pastas." }], changes: ["add-x"] }),
    proposals,
  });
  /** Sends a message and waits for the answer. */
  const say = async (id: string, text: string) => {
    await service.send(ws.id, id, text);
    await service.settled(id);
    return service.get(ws.id, id);
  };
  return { dir, root, ws, db, engine, events: seen, repo, service, proposals, workspaces, say, close: () => watcher.close() };
}
