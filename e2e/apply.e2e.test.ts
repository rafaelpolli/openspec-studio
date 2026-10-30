import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { startStack, type Stack } from "./harness.ts";

// add-visual-apply 6.1: the real embedded engine, driven by the simulated LLM, applies two
// tasks of a multi-repo change; the browser answers the permission request and reviews.
let stack: Stack;
let browser: Browser;
let page: Page;
let store: string;
let api: string;
let web: string;

const TASKS = "# Tasks\n\n## 1. Mensagem de bloqueio\n\n- [ ] 1.1 API retorna o motivo\n- [ ] 1.2 Formulário mostra a mensagem\n";

function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe" }).stdout.toString();
}

function repo(path: string, files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  git(path, "init", "-q");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "inicial");
  return path;
}

const task = (id: string) => page.locator(".apply-tasks li").filter({ hasText: id });

beforeAll(async () => {
  stack = await startStack({ mockLlm: true });
  store = join(stack.dir, "specs-store");
  api = repo(join(stack.dir, "repo-api"), { "src/auth.ts": "export function login() {}\n", "openspec/config.yaml": "store: specs-store\n" });
  web = repo(join(stack.dir, "repo-web"), { "src/login.ts": "export function form() {}\n", "openspec/config.yaml": "store: specs-store\n" });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(60_000);
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

describe("6.1 apply ponta a ponta (motor real + LLM simulado)", () => {
  test("registra o multi-repo e abre a change com tasks", async () => {
    await page.goto(stack.url);
    await page.getByRole("link", { name: "Novo workspace" }).click();
    await page.getByLabel("Multi-repo (store)").check();
    await page.getByLabel("Id do store").fill("specs-store");
    await page.getByLabel("Criar novo store").check();
    await page.getByLabel("Pasta do novo store").fill(store);
    await page.getByLabel("Iniciar repositório Git com commit inicial").uncheck();
    await page.getByLabel("Repositórios de código (um caminho por linha)").fill([api, web].join("\n"));
    await page.getByRole("button", { name: "Registrar" }).click();
    await page.getByRole("heading", { name: "specs-store", level: 1 }).waitFor();

    const cli = new OpenSpecCli({ env: stack.env });
    await cli.run(["new", "change", "mostrar-bloqueio"], { cwd: store });
    writeFileSync(join(store, "openspec", "changes", "mostrar-bloqueio", "tasks.md"), TASKS);
    await page.goto(`${page.url()}/changes/mostrar-bloqueio`);
    await page.getByRole("heading", { name: "mostrar-bloqueio", level: 1 }).waitFor();
    await task("1.1").filter({ hasText: "pendente" }).waitFor();
  });

  test("Executar todas: confirma o aviso, libera o comando e as duas tasks ficam em revisão", async () => {
    await page.getByRole("button", { name: "Executar todas" }).click();
    // The store has no Git: its openspec/ changes cannot be undone, so the run asks first.
    const warning = page.getByRole("alertdialog", { name: "Avisos antes de executar" });
    await warning.getByText(/openspec não é um repositório Git/).waitFor();
    await warning.getByRole("button", { name: "Continuar mesmo assim" }).click();

    const ask = page.getByRole("alertdialog", { name: "Pedido de permissão" });
    await ask.getByText("echo lint-web").waitFor({ timeout: 90_000 });
    await task("1.1").filter({ hasText: "aguardando revisão" }).waitFor();
    await ask.getByRole("button", { name: "Sempre neste workspace" }).click();

    await task("1.2").filter({ hasText: "aguardando revisão" }).waitFor({ timeout: 90_000 });
    expect(readFileSync(join(api, "src", "reason.ts"), "utf8")).toContain("bloqueado");
    expect(existsSync(join(web, "src", "msg.ts"))).toBe(true);
  });

  test("aceita a primeira, desfaz a segunda; nada é commitado", async () => {
    await task("1.1").getByRole("button", { name: "Revisar" }).click();
    const first = page.getByRole("article", { name: "Revisão da task 1.1" });
    await first.getByRole("heading", { name: "repo-api" }).waitFor();
    await first.getByText("src/reason.ts", { exact: true }).waitFor();
    // 1.2 was done on top of 1.1, so 1.1 cannot be undone first.
    expect(await first.getByRole("button", { name: "Desfazer" }).isDisabled()).toBe(true);
    await first.getByRole("button", { name: "Aceitar", exact: true }).click();
    await task("1.1").filter({ hasText: "aceita" }).waitFor();

    await task("1.2").getByRole("button", { name: "Revisar" }).click();
    const second = page.getByRole("article", { name: "Revisão da task 1.2" });
    await second.getByRole("heading", { name: "repo-web" }).waitFor();
    await second.getByRole("button", { name: "Desfazer" }).click();
    await task("1.2").filter({ hasText: "pendente" }).waitFor();

    const tasks = readFileSync(join(store, "openspec", "changes", "mostrar-bloqueio", "tasks.md"), "utf8");
    expect(tasks).toContain("- [x] 1.1 API retorna o motivo");
    expect(tasks).toContain("- [ ] 1.2 Formulário mostra a mensagem");
    expect(existsSync(join(web, "src", "msg.ts"))).toBe(false);
    expect(git(web, "status", "--porcelain")).toBe("");
    expect(existsSync(join(api, "src", "reason.ts"))).toBe(true);
    for (const m of [api, web]) expect(git(m, "log", "--oneline").trim().split("\n")).toHaveLength(1);
  });

  test("o comando liberado com Sempre entrou na lista do workspace", async () => {
    await page.getByRole("link", { name: "← workspace" }).click();
    await page.getByText("Configurações do apply").click();
    expect(await page.getByLabel(/Comandos liberados/).inputValue()).toContain("echo lint-web");
  });
});
