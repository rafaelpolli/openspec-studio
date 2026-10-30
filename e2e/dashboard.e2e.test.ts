import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { buildFixtureRoot } from "../packages/server/src/testing/fixture.ts";
import { startStack, type Stack } from "./harness.ts";

let stack: Stack;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  stack = await startStack();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(10_000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

/** Asserts the page shows no error banner. */
async function expectNoErrors() {
  expect(await page.locator(".banner-error").count()).toBe(0);
}

describe("5.2 cadastro de workspaces", () => {
  test("mono-repo: registra uma pasta e mostra os selos de tipo", async () => {
    const repo = join(stack.dir, "meu-app");
    await buildFixtureRoot(repo, new OpenSpecCli({ env: stack.env }));

    await page.goto(stack.url);
    await page.getByText("Nenhum workspace registrado").waitFor();
    await page.getByRole("link", { name: "Novo workspace" }).click();
    await page.getByLabel("Pasta do projeto").fill(repo);
    await page.getByRole("button", { name: "Registrar" }).click();

    await page.getByRole("heading", { name: "meu-app", level: 1 }).waitFor();
    await expect(page.locator(".badges").first().textContent()).resolves.toBe("mono-repoinicializado");
    await page.getByRole("link", { name: "add-export" }).waitFor();
    await page.getByRole("link", { name: "auth" }).waitFor();
    await expectNoErrors();
  });

  test("mono-repo: pasta inexistente mostra o erro e não registra", async () => {
    await page.goto(`${stack.url}/new`);
    await page.getByLabel("Pasta do projeto").fill(join(stack.dir, "nao-existe"));
    await page.getByRole("button", { name: "Registrar" }).click();
    await expect(page.getByRole("alert").textContent()).resolves.toContain("not an existing folder");
  });

  test("multi-repo: cria o store, aponta o membro sem store: e abre o workspace", async () => {
    const api = join(stack.dir, "repo-api");
    const legacy = join(stack.dir, "repo-legacy");
    mkdirSync(join(api, "openspec"), { recursive: true });
    mkdirSync(join(api, "src"), { recursive: true });
    writeFileSync(join(api, "src/main.ts"), "export {};\n");
    writeFileSync(join(api, "openspec/config.yaml"), "store: specs-store\n");
    mkdirSync(join(legacy, "lib"), { recursive: true });
    writeFileSync(join(legacy, "lib/app.py"), "print('hi')\n");

    await page.goto(`${stack.url}/new`);
    await page.getByLabel("Multi-repo (store)").check();
    await page.getByLabel("Id do store").fill("specs-store");
    await page.getByLabel("Criar novo store").check();
    await page.getByLabel("Pasta do novo store").fill(join(stack.dir, "specs-store"));
    await page.getByLabel("Iniciar repositório Git com commit inicial").uncheck();
    await page.getByLabel("Repositórios de código (um caminho por linha)").fill(`${api}\n${legacy}`);
    await page.getByRole("button", { name: "Registrar" }).click();

    await page.getByRole("heading", { name: "Workspace registrado" }).waitFor();
    await page.getByText("repo-legacy does not declare store 'specs-store'").waitFor();
    expect(await page.getByText("repo-api does not declare").count()).toBe(0);

    await page.getByRole("button", { name: /Gravar store: specs-store em repo-legacy/ }).click();
    await page.getByText("Todos os membros apontam para o store.").waitFor();
    expect(readFileSync(join(legacy, "openspec/config.yaml"), "utf8")).toBe("store: specs-store\n");

    await page.getByRole("link", { name: "Abrir workspace" }).click();
    await page.getByRole("heading", { name: "specs-store", level: 1 }).waitFor();
    await expect(page.locator(".badges").first().textContent()).resolves.toBe("multi-repobrownfield");
    await page.getByText("Nenhuma change ativa.").waitFor();
    await expectNoErrors();
  });

  test("a lista mostra os dois workspaces com seus selos", async () => {
    await page.goto(stack.url);
    const cards = page.locator(".card");
    await cards.nth(1).waitFor();
    const texts = await cards.allTextContents();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("meu-app");
    expect(texts[0]).toContain("mono-repo");
    expect(texts[1]).toContain("specs-store");
    expect(texts[1]).toContain("multi-repo");
    expect(texts[1]).toContain("membros: repo-api, repo-legacy");
  });
});

describe("5.6 edição externa atualiza o painel", () => {
  test("marcar uma task no tasks.md por fora atualiza a tela sem recarregar", async () => {
    await page.goto(stack.url);
    await page.getByRole("link", { name: "meu-app" }).click();
    await page.getByRole("link", { name: "add-export" }).click();

    await page.getByRole("heading", { name: "Tasks" }).waitFor();
    await page.getByRole("button", { name: /^proposal/ }).waitFor();
    expect(await page.getByLabel("concluída").count()).toBe(1);
    expect(await page.getByLabel("pendente").count()).toBe(1);

    const tasks = join(stack.dir, "meu-app/openspec/changes/add-export/tasks.md");
    const started = Date.now();
    writeFileSync(tasks, readFileSync(tasks, "utf8").replace("- [ ] 1.2 Do b", "- [x] 1.2 Do b"));

    await page.getByLabel("pendente").waitFor({ state: "detached", timeout: 5_000 });
    expect(await page.getByLabel("concluída").count()).toBe(2);
    const elapsed = Date.now() - started;
    console.log(`painel atualizado ${elapsed} ms após a edição`);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("a lista de changes do workspace também reflete o novo progresso", async () => {
    await page.getByRole("link", { name: "← workspace" }).click();
    // Cached data may render first; the invalidated query refetches on mount.
    await page.getByLabel("2 de 2 tasks").waitFor({ timeout: 5_000 });
  });
});
