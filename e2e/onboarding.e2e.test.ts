import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startStack, type Stack } from "./harness.ts";

let stack: Stack;
let browser: Browser;
let page: Page;
let repo: string;

beforeAll(async () => {
  stack = await startStack({ scriptedAgent: true });
  // A brownfield project: code, no OpenSpec.
  repo = join(stack.dir, "legado");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "auth.ts"), "export function login() {}\n");
  writeFileSync(join(repo, "src", "billing.ts"), "export function charge() {}\n");
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(30_000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

const status = (cap: string) => page.getByTestId(`status-${cap}`);

describe("8.x onboarding brownfield no navegador (agente roteirizado)", () => {
  test("init wizard: inicializa em pt-BR", async () => {
    await page.goto(stack.url);
    await page.getByRole("link", { name: "Novo workspace" }).click();
    await page.getByLabel("Pasta do projeto").fill(repo);
    await page.getByRole("button", { name: "Registrar" }).click();
    await page.getByRole("link", { name: "Inicializar" }).click();

    await page.getByRole("heading", { name: "Onboarding" }).waitFor();
    await page.getByRole("button", { name: "Inicializar" }).click();
    await page.getByRole("button", { name: "Descobrir capacidades" }).waitFor();
    expect(existsSync(join(repo, ".opencode", "commands"))).toBe(true);
  });

  test("descoberta → checkpoint: mescla, remove e confirma a estimativa", async () => {
    await page.getByRole("button", { name: "Descobrir capacidades" }).click();
    await page.getByLabel("Checkpoint de capacidades").waitFor();

    await page.getByRole("button", { name: "Remover legacy-reports" }).click();
    await page.getByLabel("Nome de billing").fill("payments");
    await page.getByRole("button", { name: "Continuar para a estimativa" }).click();

    const estimate = page.getByLabel("Estimativa");
    await estimate.waitFor();
    expect(await estimate.textContent()).toContain("2 capacidade(s)");
    expect(await estimate.textContent()).toContain("4 arquivo(s)");
    // Nothing is generated before confirming.
    expect(readdirSync(join(repo, "openspec", "changes")).filter((n) => n !== "archive")).toEqual([]);
    await page.getByRole("button", { name: "Confirmar e gerar" }).click();

    await status("auth").filter({ hasText: "pronta para revisão" }).waitFor();
    await status("payments").filter({ hasText: "pronta para revisão" }).waitFor();
    expect(readdirSync(join(repo, "openspec", "changes")).filter((n) => n !== "archive").sort()).toEqual([
      "baseline-auth",
      "baseline-payments",
    ]);
  });

  test("revisão com selo inferido e evidências; aprova auth e arquiva só ela", async () => {
    // Nothing approved yet: the archive button is disabled and says how to enable it.
    expect(await page.getByRole("button", { name: "Arquivar 0 aprovada(s)" }).isDisabled()).toBe(true);
    await page.getByText('Para arquivar, abra cada baseline pronta (botão "Abrir"), revise e clique em Aprovar.').waitFor();
    await page.getByRole("button", { name: "Abrir auth" }).click();
    const inferred = page.getByRole("article", { name: "Registrar tentativas" });
    await inferred.waitFor();
    expect(await inferred.getByText("inferido").count()).toBe(1);
    expect(await page.getByRole("article", { name: "Validar credenciais" }).textContent()).toContain(
      "api/test/auth.test.ts:5",
    );

    await page.getByRole("button", { name: "Aprovar" }).click();
    await status("auth").filter({ hasText: "aprovada" }).waitFor();
    await page.getByRole("button", { name: "Arquivar 1 aprovada(s)" }).click();

    await page.getByLabel("Resultado do archive").filter({ hasText: "arquivada baseline-auth" }).waitFor();
    await status("auth").filter({ hasText: "arquivada" }).waitFor();
    expect(existsSync(join(repo, "openspec", "specs", "auth", "spec.md"))).toBe(true);
    expect(existsSync(join(repo, "openspec", "changes", "baseline-payments"))).toBe(true);
    expect(await status("payments").textContent()).toBe("pronta para revisão");
  });
});
