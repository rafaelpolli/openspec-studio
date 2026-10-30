import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startStack, type Stack } from "./harness.ts";

const FAKE_KEY = "sk-ant-e2e-fake-key-123";
let stack: Stack;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  stack = await startStack();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(20_000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

describe("6.7 tela de Provedores (motor real, chave falsa)", () => {
  test("sem provedor, o banner aponta para a tela de Provedores", async () => {
    await page.goto(stack.url);
    await page.getByText("Nenhum provedor de LLM configurado").waitFor();
    await page.getByRole("link", { name: "configurar um provedor" }).click();
    await page.getByRole("heading", { name: "Provedores de LLM" }).waitFor();
  });

  test("salvar uma chave configura o provedor, some o banner e a chave nunca aparece", async () => {
    await page.getByLabel("Filtrar provedores").fill("anthropic");
    const card = page.getByRole("listitem", { name: "Anthropic", exact: true });
    await card.getByLabel("Chave de API de Anthropic").fill(FAKE_KEY);
    await card.getByRole("button", { name: "Salvar chave" }).click();

    await card.getByText("Credencial salva.").waitFor();
    await page.getByText("Nenhum provedor de LLM configurado").waitFor({ state: "detached" });
    expect(await card.getByLabel("Chave de API de Anthropic").inputValue()).toBe("");
    expect(await page.content()).not.toContain(FAKE_KEY);

    const auth = readFileSync(join(stack.dir, ".studio/opencode/data/opencode/auth.json"), "utf8");
    expect(auth).toContain(FAKE_KEY);
  });

  test("escolher o modelo padrão e remover o provedor", async () => {
    const select = page.getByLabel("Modelo padrão das novas sessões");
    const value = await select.locator("option").nth(1).getAttribute("value");
    await select.selectOption(value!);
    await page.waitForFunction(
      (v) => (document.querySelector(".default-model select") as HTMLSelectElement | null)?.value === v,
      value,
    );

    const card = page.getByRole("listitem", { name: "Anthropic", exact: true });
    await card.getByRole("button", { name: "Remover" }).click();
    await card.getByText("não configurado").waitFor();
    await page.getByText("Nenhum provedor de LLM configurado").waitFor();
    expect(await page.getByLabel("Modelo padrão das novas sessões").count()).toBe(0);
  });
});
