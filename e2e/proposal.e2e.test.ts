import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { startStack, type Stack } from "./harness.ts";

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
const stateOf = (id: string) => node(id).getAttribute("data-state");
async function waitState(id: string, state: string) {
  await page.waitForFunction(
    ([i, s]) => document.querySelector(`.graph button[data-state="${s}"] .node-id`)?.parentElement?.textContent?.startsWith(i!) ||
      [...document.querySelectorAll(".graph button")].some((b) => b.textContent?.startsWith(i!) && b.getAttribute("data-state") === s),
    [id, state],
    { timeout: 20_000 },
  );
}

describe("7.x propose guiado no navegador (agente roteirizado)", () => {
  test("cria a change com nome sugerido e mostra o grafo", async () => {
    await page.goto(stack.url);
    await page.getByRole("link", { name: "Novo workspace" }).click();
    await page.getByLabel("Pasta do projeto").fill(repo);
    await page.getByRole("button", { name: "Registrar" }).click();
    await page.getByRole("link", { name: "Nova change" }).click();

    await page.getByLabel("O que você quer construir ou mudar?").fill("Exportar dados do usuário em CSV");
    await page.waitForFunction(
      () => (document.querySelector('input[pattern]') as HTMLInputElement | null)?.value === "exportar-dados-usuario-csv",
    );
    await page.getByLabel("Nome da change (kebab-case)").fill("add-user-export");
    await page.getByRole("button", { name: "Criar change" }).click();

    await page.getByRole("heading", { name: "add-user-export", level: 1 }).waitFor();
    // The decisions checkpoint runs first; this change has none (add-proposal-decisions).
    await page.getByText("O agente não encontrou decisões a tomar antes do proposal.").waitFor();
    await waitState("proposal", "pronto");
    expect(await stateOf("tasks")).toBe("bloqueado");
  });

  test("gera a proposal, aprova, e as dependentes ficam prontas", async () => {
    await page.getByRole("button", { name: "Gerar proposal" }).click();
    await waitState("proposal", "aguardando_aprovacao");
    await page.getByText("Concluído").waitFor();
    await page.getByRole("heading", { name: "Why" }).waitFor();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await waitState("proposal", "aprovado");
    expect(await stateOf("specs")).toBe("pronto");
    expect(await stateOf("design")).toBe("pronto");
  });

  test("gerar o resto: specs, design e tasks ficam aguardando aprovação", async () => {
    const started = Date.now();
    await page.getByRole("button", { name: "Gerar o resto automaticamente" }).click();
    await page.waitForFunction(
      () => [...document.querySelectorAll(".graph button")].some((b) => b.textContent?.startsWith("tasks") && b.getAttribute("data-state") === "aguardando_aprovacao"),
      undefined,
      { timeout: 90_000 },
    );
    console.log(`gerar o resto levou ${Date.now() - started} ms`);
    expect(await stateOf("specs")).toBe("aguardando_aprovacao");
    expect(await stateOf("design")).toBe("aguardando_aprovacao");
    await page.getByRole("heading", { name: "Tasks" }).waitFor();
    await page.getByLabel("pendente").first().waitFor();
  });

  test("editar a proposal no CodeMirror salva o arquivo e pede nova aprovação", async () => {
    await node("proposal").click();
    await page.getByRole("button", { name: "Editar" }).click();
    const editor = page.getByLabel("Editor de proposal.md");
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nEditado no navegador.\n");
    await page.getByRole("button", { name: "Salvar" }).click();
    await waitState("proposal", "aguardando_aprovacao");
    const file = readFileSync(join(repo, "openspec/changes/add-user-export/proposal.md"), "utf8");
    expect(file).toContain("Editado no navegador.");
  });

  test("a change planejada pela UI é reconhecida e válida no CLI", async () => {
    const cli = new OpenSpecCli({ env: stack.env });
    const validate = await cli.run(["validate", "add-user-export", "--json"], { cwd: repo });
    expect(JSON.parse(validate.stdout).items[0].valid).toBe(true);
    const status = JSON.parse((await cli.run(["status", "--change", "add-user-export", "--json"], { cwd: repo })).stdout);
    expect(status.isPlanningComplete).toBe(true);
  });
});
