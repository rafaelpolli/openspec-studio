import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { explorationSetup, type AgentScript } from "./testing.ts";

setDefaultTimeout(60_000);

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((c) => c()));
async function setup(script: AgentScript = {}) {
  const t = await explorationSetup(script);
  cleanups.push(() => {
    t.close();
    rmSync(t.dir, { recursive: true, force: true });
  });
  return t;
}

describe("2.2 conversa da exploração", () => {
  test("Conversa contínua: two exchanges in one session; the first prompt has the specs and changes, the next only the message", async () => {
    const t = await setup({ title: "BMAD no projeto" });
    const e = t.service.create(t.ws.id);
    expect(t.service.list(t.ws.id).map((x) => [x.id, x.status])).toEqual([[e.id, "ativa"]]);
    await t.say(e.id, "o que do BMAD eu poderia incluir?");
    const after = await t.say(e.id, "detalhe a opção de verificação");
    expect(after.messages.map((m) => [m.role, m.text, m.status])).toEqual([
      ["usuario", "o que do BMAD eu poderia incluir?", "concluida"],
      ["agente", "resposta a: o que do BMAD eu poderia incluir?", "concluida"],
      ["usuario", "detalhe a opção de verificação", "concluida"],
      ["agente", "resposta a: detalhe a opção de verificação", "concluida"],
    ]);
    const [first, second] = t.engine.prompts;
    expect(second!.sessionId).toBe(first!.sessionId);
    expect(first!.text).toContain("- `workspaces`: Registrar pastas.");
    expect(first!.text).toContain("## Changes ativas\n\n- `add-x`");
    expect(second!.text).toBe("detalhe a opção de verificação");
    expect(t.events.some((ev) => ev.type === "exploration-changed")).toBe(true);
  });

  test("Título sugerido; a title the user edits is never replaced; no title shows the first message", async () => {
    const t = await setup({ title: "BMAD no projeto" });
    const e = t.service.create(t.ws.id);
    expect((await t.say(e.id, "pergunta longa sobre o BMAD")).title).toBe("BMAD no projeto");
    t.service.rename(t.ws.id, e.id, "Meu título");
    const untitled = await setup({});
    const u = untitled.service.create(untitled.ws.id);
    const got = await untitled.say(u.id, "uma ideia sem título");
    expect([got.title, got.preview]).toEqual([null, "uma ideia sem título"]);
    expect(t.service.get(t.ws.id, e.id).title).toBe("Meu título");
  });

  test("Parar: the partial text stays as interrupted, and new messages are accepted again; one answer at a time", async () => {
    let hang = true;
    const t = await setup({ answer: () => (hang ? "hang" : "ok") });
    const e = t.service.create(t.ws.id);
    await t.service.send(t.ws.id, e.id, "primeira");
    for (let i = 0; i < 100 && !t.service.get(t.ws.id, e.id).busy; i++) await Bun.sleep(5);
    expect(t.service.get(t.ws.id, e.id).busy).toBe(true);
    await expect(t.service.send(t.ws.id, e.id, "outra")).rejects.toThrow("espere o agente terminar a resposta");
    const stopped = await t.service.stop(t.ws.id, e.id);
    expect(stopped.busy).toBe(false);
    expect(stopped.messages.at(-1)).toMatchObject({ role: "agente", status: "interrompida" });
    hang = false;
    expect((await t.say(e.id, "segunda")).messages.at(-1)).toMatchObject({ text: "ok", status: "concluida" });
  });

  test("a failed answer keeps the error; Depois de reiniciar an answer in progress is interrupted", async () => {
    const t = await setup({ answer: () => "fail" });
    const e = t.service.create(t.ws.id);
    const got = await t.say(e.id, "oi");
    expect(got.messages.at(-1)).toMatchObject({ status: "falhou" });
    expect(got.messages.at(-1)!.text).toContain("sem chave");
    const m = t.repo.addMessage(e.id, "agente", "meio", "respondendo");
    t.service.start();
    expect(t.repo.messages(e.id).find((x) => x.id === m)!.status).toBe("interrompida");
  });

  test("Escrita negada: read-only permissions, and a write into a clean Git member is reverted", async () => {
    const t = await setup({ writeMember: "export const a = 2;\n" });
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: t.root });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    const e = t.service.create(t.ws.id);
    await t.say(e.id, "oi");
    const perms = [...t.engine.permissions.values()][0]!;
    const writable = perms.filter((r) => r.permission === "edit" && r.action === "allow").map((r) => r.pattern);
    expect(writable.some((p) => p.includes("openspec") || p.startsWith(t.root))).toBe(false);
    expect(perms).toContainEqual({ permission: "bash", pattern: "*", action: "deny" });
    expect(readFileSync(join(t.root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  test("404 for an exploration of another workspace", async () => {
    const t = await setup({});
    const e = t.service.create(t.ws.id);
    expect(() => t.service.get("outro", e.id)).toThrow();
  });
});

const DRAFT = {
  name: "add-change-verification",
  description: "Verificar a change antes do archive.",
  decisions: [{ question: "Nível de prova", answer: "B+C como base, D opcional por cenário" }],
};

describe("3.2 virar change", () => {
  test("Rascunho revisado → Change criada: the reviewed decisions reach the checkpoint, exploration.md has the conversation", async () => {
    const t = await setup({ title: "Verificação", draft: DRAFT });
    const e = t.service.create(t.ws.id);
    await expect(t.service.draft(t.ws.id, e.id)).rejects.toThrow("converse com o agente antes de virar change");
    await t.say(e.id, "como ter confiança no resultado?");
    await t.service.draft(t.ws.id, e.id);
    await t.service.settled(e.id);
    const withDraft = t.service.get(t.ws.id, e.id);
    expect(withDraft.draft).toEqual(DRAFT);
    // The draft request is not part of the conversation.
    expect(withDraft.messages).toHaveLength(2);
    const reviewed = { ...DRAFT, decisions: [...DRAFT.decisions, { question: "Archive na UI", answer: "com portão" }] };
    const closed = await t.service.toChange(t.ws.id, e.id, reviewed);
    expect(closed).toMatchObject({ status: "virou-change", change: "add-change-verification" });
    await t.proposals.settled(t.ws.id, "add-change-verification");
    const view = await t.proposals.view(t.ws.id, "add-change-verification");
    expect(view.description).toBe("Verificar a change antes do archive.");
    expect(view.decisions?.decisions.map((d) => [d.question, d.source])).toEqual([
      ["Nível de prova", "exploracao"],
      ["Archive na UI", "exploracao"],
    ]);
    const md = readFileSync(join(t.root, "openspec/changes/add-change-verification/exploration.md"), "utf8");
    expect(md).toStartWith("# Exploração: Verificação\n");
    expect(md).toContain("- **Archive na UI:** com portão");
    expect(md).toContain("### Usuário\n\ncomo ter confiança no resultado?\n\n### Agente\n\nresposta a: como ter confiança no resultado?");
    await expect(t.service.send(t.ws.id, e.id, "mais uma")).rejects.toThrow("encerrada (virou change)");
  });

  test("an invalid draft is an error shown on the exploration; an invalid name is replaced", async () => {
    let draft: unknown = "não é json";
    const t = await setup({ get draft() { return draft; } } as never);
    const e = t.service.create(t.ws.id);
    await t.say(e.id, "oi");
    await t.service.draft(t.ws.id, e.id);
    await t.service.settled(e.id);
    expect(t.service.get(t.ws.id, e.id)).toMatchObject({ draftError: "o agente escreveu um rascunho que não é JSON" });
    draft = { ...DRAFT, name: "Nome Inválido", description: "Exportar dados em CSV" };
    await t.service.draft(t.ws.id, e.id);
    await t.service.settled(e.id);
    const got = t.service.get(t.ws.id, e.id);
    expect(got.draftError).toBeUndefined();
    expect(got.draft?.name).toBe("exportar-dados-csv");
  });

  test("Nome em uso: refused, the exploration stays active with the draft kept", async () => {
    const t = await setup({ draft: DRAFT });
    await t.proposals.create(t.ws.id, "add-change-verification", "já existe");
    await t.proposals.settled(t.ws.id, "add-change-verification");
    const e = t.service.create(t.ws.id);
    await t.say(e.id, "oi");
    await expect(t.service.toChange(t.ws.id, e.id, DRAFT)).rejects.toThrow("já existe uma change ativa chamada add-change-verification");
    expect(t.service.get(t.ws.id, e.id)).toMatchObject({ status: "ativa", draft: DRAFT });
  });
});

describe("3.3 descartar e continuar", () => {
  test("Descartar: only an active one; Continuar a partir de outra carries the summary of one that became a change", async () => {
    const t = await setup({ draft: DRAFT });
    const e = t.service.create(t.ws.id);
    expect(() => t.service.create(t.ws.id, e.id)).toThrow("só dá para continuar a partir de uma exploração encerrada");
    await t.say(e.id, "como verificar?");
    await t.service.toChange(t.ws.id, e.id, DRAFT);
    await t.proposals.settled(t.ws.id, DRAFT.name);
    expect(() => t.service.discard(t.ws.id, e.id)).toThrow();
    const next = t.service.create(t.ws.id, e.id);
    expect(next.parentId).toBe(e.id);
    await t.say(next.id, "e as decisões na proposta?");
    const first = t.engine.prompts.filter((p) => p.text.startsWith("# Exploração")).at(-1)!.text;
    expect(first).toContain("## Exploração anterior\n\n\"sem título\", que virou a change `add-change-verification`.\n\nVerificar a change antes do archive.\n\n- Nível de prova: B+C como base, D opcional por cenário");
  });

  test("a discarded one is read-only and passes its last messages on", async () => {
    const t = await setup({});
    const e = t.service.create(t.ws.id);
    await t.say(e.id, "dark mode?");
    expect(t.service.discard(t.ws.id, e.id).status).toBe("descartada");
    await expect(t.service.send(t.ws.id, e.id, "x")).rejects.toThrow("descartada");
    const next = t.service.create(t.ws.id, e.id);
    await t.say(next.id, "retomando");
    const first = t.engine.prompts.at(-1)!.text;
    expect(first).toContain('"sem título", descartada.');
    expect(first).toContain("**Usuário:** dark mode?");
    expect(first).toContain("**Agente:** resposta a: dark mode?");
  });
});
