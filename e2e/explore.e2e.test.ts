import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { startStack, type Stack } from "./harness.ts";

// add-workspace-explore 5.1: an exploration in the browser, with the scripted agent, turned into
// a change whose checkpoint starts with the conversation's decision already answered.
let stack: Stack;
let browser: Browser;
let page: Page;
let repo: string;
let workspaceUrl: string;
let explorationUrl: string;

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

const prompts = () => readFileSync(join(stack.dir, ".studio", "prompts.log"), "utf8").split("\n---\n");
const messages = () => page.locator(".exploration-message");

describe("5.1 exploração no navegador (agente roteirizado)", () => {
  test("Nova exploração → two messages in one conversation → the suggested title", async () => {
    await page.goto(stack.url);
    await page.getByRole("link", { name: "Novo workspace" }).click();
    await page.getByLabel("Pasta do projeto").fill(repo);
    await page.getByRole("button", { name: "Registrar" }).click();
    await page.getByRole("region", { name: "Explorações" }).waitFor();
    workspaceUrl = page.url();
    await page.getByRole("button", { name: "Nova exploração" }).click();
    await page.getByLabel("Mensagem").waitFor();
    explorationUrl = page.url();

    await page.getByLabel("Mensagem").fill("quero exportar os dados do usuário");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByText("Resposta do agente: quero exportar os dados do usuário").waitFor();
    await page.getByRole("heading", { name: "Exportar dados", level: 1 }).waitFor();
    await page.getByLabel("Mensagem").fill("em CSV, pela tela de perfil");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByText("Resposta do agente: em CSV, pela tela de perfil").waitFor();
    expect(await messages().count()).toBe(4);
    const exploration = prompts().filter((p) => p.startsWith("# Exploração") || p === "em CSV, pela tela de perfil");
    expect(exploration[0]).toContain("## Mensagem do usuário\n\nquero exportar os dados do usuário");
    expect(exploration[1]).toBe("em CSV, pela tela de perfil");
  });

  test("Rascunho revisado → Change criada: the edited decision arrives answered, from the exploration", async () => {
    await page.getByRole("button", { name: "Virar change" }).click();
    const form = page.getByRole("form", { name: "Virar change" });
    await form.waitFor();
    expect(await form.getByLabel("Nome da change").inputValue()).toBe("add-export-csv");
    await form.getByLabel("Resposta 1").fill("CSV com cabeçalho");
    await form.getByRole("button", { name: "Criar change" }).click();

    await page.getByRole("heading", { name: "add-export-csv", level: 1 }).waitFor();
    await page.getByText("Exportar os dados do usuário em CSV, a partir da tela de perfil.").waitFor();
    const checkpoint = page.getByRole("region", { name: "Decisões da change" });
    await checkpoint.getByText("(da exploração)").waitFor();
    expect(await checkpoint.textContent()).toContain("CSV com cabeçalho");
    const md = readFileSync(join(repo, "openspec/changes/add-export-csv/exploration.md"), "utf8");
    expect(md).toStartWith("# Exploração: Exportar dados\n");
    expect(md).toContain("- **Formato do arquivo:** CSV com cabeçalho");
    expect(md).toContain("### Usuário\n\nem CSV, pela tela de perfil");
    const checkpointPrompt = prompts().find((p) => p.startsWith("# Decisões em aberto da change `add-export-csv`"))!;
    expect(checkpointPrompt).toContain("- Formato do arquivo → CSV com cabeçalho");
  });

  test("the list shows it as virou change; Continuar a partir de… starts with the previous summary", async () => {
    await page.goto(workspaceUrl);
    const list = page.getByRole("region", { name: "Explorações" });
    await list.getByText("virou change").waitFor();
    await list.getByRole("link", { name: "→ add-export-csv" }).waitFor();

    await page.goto(explorationUrl);
    expect(await page.getByLabel("Mensagem").count()).toBe(0);
    await page.getByRole("button", { name: "Continuar a partir de…" }).click();
    await page.waitForURL((url) => url.toString() !== explorationUrl);
    await page.getByLabel("Mensagem").fill("e o export em JSON?");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByText("Resposta do agente: e o export em JSON?").waitFor();
    const continued = prompts().filter((p) => p.startsWith("# Exploração")).at(-1)!;
    expect(continued).toContain("## Exploração anterior\n\n\"Exportar dados\", que virou a change `add-export-csv`.");
    expect(continued).toContain("- Formato do arquivo: CSV com cabeçalho");
  });
});
