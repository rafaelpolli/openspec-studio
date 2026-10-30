import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { startStack, type Stack } from "./harness.ts";

let stack: Stack;
let browser: Browser;
let page: Page;
let store: string;
let members: string[];
let before: Record<string, string>;

/** Path → content hash (plus mode and mtime) of every file under the members. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const st = statSync(child);
      if (st.isDirectory()) walk(child);
      else out[child] = `${createHash("sha256").update(readFileSync(child)).digest("hex")}:${st.mode}:${st.mtimeMs}`;
    }
  };
  for (const m of members) walk(m);
  return out;
}

const status = (cap: string) => page.getByTestId(`status-${cap}`);
const node = (id: string) => page.getByRole("button", { name: new RegExp(`^${id}`) });

beforeAll(async () => {
  stack = await startStack({ scriptedAgent: true });
  store = join(stack.dir, "specs-store");
  members = ["repo-api", "repo-web"].map((name) => join(stack.dir, name));
  for (const m of members) {
    mkdirSync(join(m, "src"), { recursive: true });
    mkdirSync(join(m, "openspec"));
    // Both members already declare the store, so registering changes nothing in them.
    writeFileSync(join(m, "openspec", "config.yaml"), "store: specs-store\n");
  }
  writeFileSync(join(members[0]!, "src", "auth.ts"), "export function login() {}\n");
  writeFileSync(join(members[1]!, "src", "login.tsx"), "export function LoginForm() {}\n");
  before = snapshot();
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(30_000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

describe("9.3 multi-repo (store + 2 repos) no navegador (agente roteirizado)", () => {
  test("registra com store novo e abre o painel", async () => {
    await page.goto(stack.url);
    await page.getByRole("link", { name: "Novo workspace" }).click();
    await page.getByLabel("Multi-repo (store)").check();
    await page.getByLabel("Id do store").fill("specs-store");
    await page.getByLabel("Criar novo store").check();
    await page.getByLabel("Pasta do novo store").fill(store);
    await page.getByLabel("Iniciar repositório Git com commit inicial").uncheck();
    await page.getByLabel("Repositórios de código (um caminho por linha)").fill(members.join("\n"));
    await page.getByRole("button", { name: "Registrar" }).click();
    // Both members already declare the store: no pending issue, so the workspace opens directly.
    await page.getByRole("heading", { name: "specs-store", level: 1 }).waitFor();
    await page.getByRole("heading", { name: "Changes" }).waitFor();
    await page.getByRole("heading", { name: "Specs", exact: true }).waitFor();
  });

  test("onboarding: init no store, descoberta nos dois membros, baselines e archive", async () => {
    await page.getByRole("link", { name: "Inicializar" }).click();
    await page.getByRole("button", { name: "Inicializar" }).click();
    await page.getByRole("button", { name: "Descobrir capacidades" }).click();
    await page.getByLabel("Checkpoint de capacidades").waitFor();
    // Discovery points every capability at both members.
    expect(await page.getByText("repo-api:src, repo-web:src").count()).toBe(3);
    await page.getByRole("button", { name: "Remover legacy-reports" }).click();
    await page.getByRole("button", { name: "Remover billing" }).click();
    await page.getByRole("button", { name: "Continuar para a estimativa" }).click();
    expect(await page.getByLabel("Estimativa").textContent()).toContain("2 arquivo(s)");
    await page.getByRole("button", { name: "Confirmar e gerar" }).click();

    await status("auth").filter({ hasText: "pronta para revisão" }).waitFor();
    await page.getByRole("button", { name: "Abrir auth" }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await page.getByRole("button", { name: "Arquivar 1 aprovada(s)" }).click();
    await page.getByLabel("Resultado do archive").filter({ hasText: "arquivada baseline-auth" }).waitFor();
    expect(existsSync(join(store, "openspec", "specs", "auth", "spec.md"))).toBe(true);
  });

  test("painel e propose sobre o store", async () => {
    await page.getByRole("link", { name: "← specs-store" }).click();
    await page.getByRole("link", { name: "auth" }).waitFor();
    await page.getByRole("link", { name: "Nova change" }).click();
    await page.getByLabel("O que você quer construir ou mudar?").fill("Exportar dados em CSV");
    await page.getByLabel("Nome da change (kebab-case)").fill("add-export");
    await page.getByRole("button", { name: "Criar change" }).click();
    await page.getByRole("heading", { name: "add-export", level: 1 }).waitFor();
    await page.getByRole("button", { name: "Gerar o resto automaticamente" }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".graph button")].some(
          (b) => b.textContent?.startsWith("tasks") && b.getAttribute("data-state") === "aguardando_aprovacao",
        ),
      undefined,
      { timeout: 90_000 },
    );
    expect(await node("proposal").getAttribute("data-state")).toBe("aguardando_aprovacao");

    const cli = new OpenSpecCli({ env: stack.env });
    const status = JSON.parse((await cli.run(["status", "--change", "add-export", "--json"], { cwd: store })).stdout);
    expect(status.isPlanningComplete).toBe(true);
    expect(status.changeRoot).toBe(join(store, "openspec", "changes", "add-export"));
  });

  test("nenhum arquivo dos membros foi alterado", () => {
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(store, ".opencode", "commands"))).toBe(true);
    for (const m of members) expect(existsSync(join(m, ".opencode"))).toBe(false);
  });
});
