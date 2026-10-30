import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { startStack, type Stack } from "./harness.ts";

// add-proposal-decisions 6.1: the decisions checkpoint in the browser, with the scripted agent.
// A change described "com decisões" gets one decision, and its proposal one assumption.
let stack: Stack;
let browser: Browser;
let page: Page;
let repo: string;

beforeAll(async () => {
  stack = await startStack({ scriptedAgent: true });
  repo = join(stack.dir, "app");
  mkdirSync(repo);
  await new OpenSpecCli({ env: stack.env }).run(["init", "--tools", "none", "--no-animation"], { cwd: repo });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(20_000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

const node = (id: string) => page.getByRole("button", { name: new RegExp(`^${id}`) });
const waitState = (id: string, state: string) =>
  page.waitForFunction(
    ([i, s]) => [...document.querySelectorAll(".graph button")].some((b) => b.textContent?.startsWith(i!) && b.getAttribute("data-state") === s),
    [id, state],
    { timeout: 20_000 },
  );
const prompts = () => readFileSync(join(stack.dir, ".studio", "prompts.log"), "utf8").split("\n---\n");
const decisionsMd = () => readFileSync(join(repo, "openspec/changes/add-export/decisions.md"), "utf8");

describe("6.1 checkpoint de decisões no navegador (agente roteirizado)", () => {
  test("Decisões levantadas: the new change opens with the decision and the proposal waits", async () => {
    await page.goto(stack.url);
    await page.getByRole("link", { name: "Novo workspace" }).click();
    await page.getByLabel("Pasta do projeto").fill(repo);
    await page.getByRole("button", { name: "Registrar" }).click();
    await page.getByRole("link", { name: "Nova change" }).click();
    await page.getByLabel("O que você quer construir ou mudar?").fill("Exportar dados em CSV com decisões");
    await page.getByLabel("Nome da change (kebab-case)").fill("add-export");
    await page.getByRole("button", { name: "Criar change" }).click();

    const checkpoint = page.getByRole("form", { name: "Decisões da change" });
    await checkpoint.getByText("Quais campos entram no CSV?").waitFor();
    expect(await checkpoint.getByRole("radio", { name: /Só nome e e-mail/ }).isChecked()).toBe(true);
    expect(await node("proposal").getAttribute("data-state")).toBe("bloqueado");
  });

  test("Resposta própria → the proposal's prompt carries it → the assumption at approval → decisions.md", async () => {
    const checkpoint = page.getByRole("form", { name: "Decisões da change" });
    await checkpoint.getByRole("radio", { name: "Outra resposta" }).check();
    await checkpoint.getByLabel("Outra resposta para Quais campos entram no CSV?").fill("só o e-mail");
    await checkpoint.getByRole("button", { name: "Salvar respostas" }).click();
    await page.getByRole("region", { name: "Decisões da change" }).getByRole("button", { name: "Editar respostas" }).waitFor();
    expect(decisionsMd()).toContain("- Resposta: só o e-mail (resposta própria)");

    await waitState("proposal", "pronto");
    await page.getByRole("button", { name: "Gerar proposal" }).click();
    await waitState("proposal", "aguardando_aprovacao");
    const proposalPrompt = prompts().find((p) => p.startsWith("# Artefato: proposal"))!;
    expect(proposalPrompt).toContain("## Decisões do usuário (siga)\n\n- Quais campos entram no CSV? → só o e-mail");

    const assumptions = page.getByRole("region", { name: "Suposições do agente" });
    await assumptions.getByText("o export roda em segundo plano").waitFor();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await waitState("proposal", "aprovado");
    expect(decisionsMd()).toContain("## Suposições aceitas\n\n### proposal\n\n- o export roda em segundo plano");
  });

  test("Resposta alterada depois: editing the answer sends the generated proposal to a revisar", async () => {
    await page.getByRole("button", { name: "Editar respostas" }).click();
    const checkpoint = page.getByRole("form", { name: "Decisões da change" });
    await checkpoint.getByText(/o artefato já gerado/).waitFor();
    await checkpoint.getByRole("radio", { name: /^Todos/ }).check();
    await checkpoint.getByRole("button", { name: "Salvar respostas" }).click();
    await waitState("proposal", "a_revisar");
    await node("proposal").click();
    await page.getByText(/Uma decisão da change mudou depois que este artefato foi gerado/).waitFor();
    expect(decisionsMd()).toContain("- Resposta: Todos (outra opção)");
  });
});
