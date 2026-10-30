import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db.ts";
import { ExplorationRepo } from "./repo.ts";

function setup() {
  const db = openDatabase(":memory:");
  db.run("INSERT INTO workspaces (id, name, kind, root_path, store_id, created_at) VALUES ('w', 'w', 'mono', '/x', NULL, 'now')");
  return { db, repo: new ExplorationRepo(db) };
}

describe("1.2 repositório de explorações", () => {
  test("create, list with the preview of the first message, the most recent first", async () => {
    const { repo } = setup();
    const a = repo.create("w");
    await Bun.sleep(2);
    const b = repo.create("w", a.id);
    repo.addMessage(b.id, "usuario", "o que do BMAD eu poderia incluir no projeto? ".repeat(3), "concluida");
    expect(repo.list("w").map((e) => e.id)).toEqual([b.id, a.id]);
    const got = repo.get(b.id)!;
    expect(got).toMatchObject({ status: "ativa", title: null, parentId: a.id, titleByUser: false });
    expect(got.preview).toHaveLength(60);
    expect(repo.get(a.id)!.preview).toBe("");
  });

  test("messages in order; an answer updated in place", () => {
    const { repo } = setup();
    const e = repo.create("w");
    repo.addMessage(e.id, "usuario", "oi", "concluida");
    const answer = repo.addMessage(e.id, "agente", "", "respondendo");
    repo.updateMessage(answer, "olá", "concluida");
    expect(repo.messages(e.id).map((m) => [m.role, m.text, m.status])).toEqual([
      ["usuario", "oi", "concluida"],
      ["agente", "olá", "concluida"],
    ]);
  });

  test("the agent's title never replaces one the user wrote", () => {
    const { repo } = setup();
    const e = repo.create("w");
    repo.setTitle(e.id, "Sugerido", false);
    expect(repo.get(e.id)!.title).toBe("Sugerido");
    repo.setTitle(e.id, "Meu título", true);
    repo.setTitle(e.id, "Outro sugerido", false);
    expect(repo.get(e.id)!).toMatchObject({ title: "Meu título", titleByUser: true });
  });

  test("state, change, summary and draft; after a restart an answer in progress is interrupted", () => {
    const { repo } = setup();
    const e = repo.create("w");
    repo.setDraft(e.id, { name: "add-x", description: "desc", decisions: [{ question: "q", answer: "a" }] });
    repo.setStatus(e.id, "virou-change", { change: "add-x", summary: "resumo" });
    expect(repo.get(e.id)).toMatchObject({ status: "virou-change", change: "add-x", summary: "resumo", draft: { name: "add-x" } });
    const m = repo.addMessage(e.id, "agente", "parcial", "respondendo");
    repo.interruptRunning();
    expect(repo.messages(e.id).find((x) => x.id === m)!.status).toBe("interrompida");
  });
});
