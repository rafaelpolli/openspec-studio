import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { startStack, type Stack } from "./harness.ts";

// add-git-commits 7.1: a multi-repo workspace whose member `legado` has no Git. The browser
// initializes it from the apply warning, gives it its own identity, runs a task that changes
// two members (real engine + simulated LLM) and accepts it with a commit.
let stack: Stack;
let browser: Browser;
let page: Page;
let store: string;
let api: string;
let legado: string;
let gitconfig: string;

const GLOBAL = "[user]\n\tname = Global E2E\n\temail = global@e2e\n";
const TASKS = "# Tasks\n\n## 1. Bloqueio\n\n- [ ] 1.1 API e legado avisam o bloqueio\n";

/** Git as the backend sees it: the stack's own global config. */
function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: stack.gitConfig, GIT_CONFIG_NOSYSTEM: "1" },
  }).stdout.toString();
}

function folder(path: string, files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  return path;
}

const lastFiles = (repo: string) => git(repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean).sort();
const task = (id: string) => page.locator(".apply-tasks li").filter({ hasText: id });

beforeAll(async () => {
  stack = await startStack({ entry: "src/testing/e2e-git-server.ts", gitConfig: GLOBAL });
  gitconfig = readFileSync(stack.gitConfig, "utf8");
  store = join(stack.dir, "specs-store");
  api = folder(join(stack.dir, "repo-api"), { "src/auth.ts": "export function login() {}\n", "openspec/config.yaml": "store: specs-store\n" });
  git(api, "init", "-q");
  git(api, "add", "-A");
  git(api, "commit", "-q", "-m", "inicial");
  legado = folder(join(stack.dir, "legado"), {
    "src/main.ts": "export const main = 1;\n",
    ".env": "SENHA=1\n",
    "openspec/config.yaml": "store: specs-store\n",
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(60_000);
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

describe("7.1 Git pela app (motor real + LLM simulado)", () => {
  test("registers the multi-repo with a store in Git and opens the change", async () => {
    await page.goto(stack.url);
    await page.getByRole("link", { name: "Novo workspace" }).click();
    await page.getByLabel("Multi-repo (store)").check();
    await page.getByLabel("Id do store").fill("specs-store");
    await page.getByLabel("Criar novo store").check();
    await page.getByLabel("Pasta do novo store").fill(store);
    await page.getByLabel("Iniciar repositório Git com commit inicial").check();
    await page.getByLabel("Repositórios de código (um caminho por linha)").fill([api, legado].join("\n"));
    await page.getByRole("button", { name: "Registrar" }).click();
    await page.getByRole("heading", { name: "specs-store", level: 1 }).waitFor();

    const cli = new OpenSpecCli({ env: stack.env });
    await cli.run(["new", "change", "avisar-bloqueio"], { cwd: store });
    writeFileSync(join(store, "openspec", "changes", "avisar-bloqueio", "tasks.md"), TASKS);
    git(store, "add", "-A");
    git(store, "commit", "-q", "-m", "change");
    await page.goto(`${page.url()}/changes/avisar-bloqueio`);
    await page.getByRole("heading", { name: "avisar-bloqueio", level: 1 }).waitFor();
    await task("1.1").filter({ hasText: "pendente" }).waitFor();
  });

  test("Resolver pelo aviso: Inicializar Git in legado, with .env left out, and the warning goes away", async () => {
    await page.getByRole("button", { name: "Executar próxima" }).click();
    const warning = page.getByRole("alertdialog", { name: "Avisos antes de executar" });
    await warning.getByText(/legado não é um repositório Git/).waitFor();
    await warning.getByRole("button", { name: "Inicializar Git" }).click();

    const dialog = page.getByRole("form", { name: "Inicializar Git em legado" });
    await dialog.getByText(/\.env parece conter segredos: fica fora do commit/).waitFor();
    expect(await dialog.getByLabel(".gitignore").inputValue()).toContain(".env");
    await dialog.getByRole("button", { name: "Inicializar e fazer commit inicial" }).click();
    await warning.waitFor({ state: "detached" });

    expect(lastFiles(legado)).toEqual([".gitignore", "openspec/config.yaml", "src/main.ts"]);
    expect(git(legado, "log", "--format=%an").trim()).toBe("Global E2E");
  });

  test("Identidade própria do repo: legado gets its own author; the global config is untouched", async () => {
    await page.getByRole("link", { name: "← workspace" }).click();
    const row = page.locator(".git-area").filter({ hasText: "legado" });
    await row.getByRole("button", { name: "Identidade própria" }).click();
    await row.getByLabel("Nome").fill("Ana");
    await row.getByLabel("E-mail").fill("ana@empresa.com");
    await row.getByRole("button", { name: "Salvar identidade do repo" }).click();
    await page.getByLabel("Identidade de legado").filter({ hasText: "Ana <ana@empresa.com> (do repo)" }).waitFor();
    await page.getByLabel("Identidade de repo-api").filter({ hasText: "Global E2E <global@e2e> (global)" }).waitFor();
    expect(readFileSync(stack.gitConfig, "utf8")).toBe(gitconfig);
  });

  test("Aceitar e commitar: one commit per repo, each with only its files and author, tasks.md in the store", async () => {
    await page.getByRole("link", { name: "avisar-bloqueio" }).first().click();
    await page.getByRole("button", { name: "Executar próxima" }).click();
    await task("1.1").filter({ hasText: "aguardando revisão" }).waitFor({ timeout: 90_000 });
    await task("1.1").getByRole("button", { name: "Revisar" }).click();
    const review = page.getByRole("article", { name: "Revisão da task 1.1" });
    await review.getByRole("button", { name: "Aceitar e commitar" }).click();
    const dialog = review.getByRole("form", { name: "Aceitar e commitar" });
    expect(await dialog.getByLabel("Mensagem do commit").inputValue()).toBe("avisar-bloqueio: 1.1 API e legado avisam o bloqueio");
    await dialog.getByText(/Um commit em: repo-api, legado, openspec/).waitFor();
    await dialog.getByRole("button", { name: "Commitar" }).click();
    await task("1.1").filter({ hasText: "aceita" }).waitFor();

    expect(lastFiles(api)).toEqual(["src/reason.ts"]);
    expect(git(api, "log", "-1", "--format=%an|%s").trim()).toBe("Global E2E|avisar-bloqueio: 1.1 API e legado avisam o bloqueio");
    expect(lastFiles(legado)).toEqual(["src/aviso.ts"]);
    expect(git(legado, "log", "-1", "--format=%an").trim()).toBe("Ana");
    expect(lastFiles(store)).toEqual(["openspec/changes/avisar-bloqueio/tasks.md"]);
    expect(git(store, "show", "HEAD:openspec/changes/avisar-bloqueio/tasks.md")).toContain("- [x] 1.1");
    for (const repo of [api, legado, store]) expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(stack.gitConfig, "utf8")).toBe(gitconfig);
  });
});
