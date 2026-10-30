import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { OpenSpecCli } from "../packages/server/src/openspec/cli.ts";
import { startStack, type Stack } from "./harness.ts";

// add-change-verification 8.1: a mono-repo with a `bun test` project and a change with two
// scenarios, one with a test and one without. The browser verifies (CONCERNS), proves the
// covered scenario (forte), generates the missing test task, runs it, verifies again (PASS)
// and archives with a commit. Real engine + simulated LLM.
let stack: Stack;
let browser: Browser;
let page: Page;
let app: string;

const CHANGE = "corrigir-soma";
const GLOBAL = "[user]\n\tname = Global E2E\n\temail = global@e2e\n";
const SPEC = [
  "## ADDED Requirements",
  "",
  "### Requirement: Somar",
  "O sistema SHALL somar dois números.",
  "",
  "#### Scenario: Soma dois números",
  "- **WHEN** soma(1, 2)",
  "- **THEN** o resultado é 3",
  "",
  "#### Scenario: Soma com zero",
  "- **WHEN** soma(0, 5)",
  "- **THEN** o resultado é 5",
  "",
].join("\n");

/** Git as the backend sees it: the stack's own global config. */
function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: stack.gitConfig, GIT_CONFIG_NOSYSTEM: "1" },
  }).stdout.toString();
}

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const task = (id: string) => page.locator(".apply-tasks li").filter({ hasText: id });
const panel = () => page.getByRole("region", { name: "Verificação" });
const item = (name: string) => panel().locator("li.verification-item").filter({ hasText: name });

/** Runs the next task, going past the pending-changes warning when it shows. */
async function runNext() {
  await page.getByRole("button", { name: "Executar próxima" }).click();
  const warning = page.getByRole("alertdialog", { name: "Avisos antes de executar" });
  const shown = await warning.waitFor({ timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (shown) await warning.getByRole("button", { name: "Continuar mesmo assim" }).click();
}

async function accept(id: string) {
  await task(id).filter({ hasText: "aguardando revisão" }).waitFor({ timeout: 90_000 });
  await task(id).getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("article", { name: `Revisão da task ${id}` }).getByRole("button", { name: "Aceitar", exact: true }).click();
  await task(id).filter({ hasText: "aceita" }).waitFor();
}

async function verify(verdict: string) {
  await panel().getByRole("button", { name: "Verificar change", exact: true }).click();
  await panel().getByText(`Veredito: ${verdict}`).waitFor({ timeout: 90_000 });
}

beforeAll(async () => {
  stack = await startStack({ entry: "src/testing/e2e-verification-server.ts", gitConfig: GLOBAL });
  app = join(stack.dir, "app");
  write(join(app, "package.json"), '{"name":"app","scripts":{"test":"bun test"}}\n');
  write(join(app, "bun.lock"), "");
  // `soma` is wrong until task 1.1 fixes it, so its test fails before the change.
  write(join(app, "src", "soma.ts"), "export const soma = (a: number, b: number) => a - b;\n");
  write(
    join(app, "src", "soma.test.ts"),
    'import { expect, test } from "bun:test";\nimport { soma } from "./soma.ts";\n\ntest("Soma dois números", () => {\n  expect(soma(1, 2)).toBe(3);\n});\n',
  );
  const cli = new OpenSpecCli({ env: stack.env });
  await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: app });
  await cli.run(["new", "change", CHANGE], { cwd: app });
  const changeDir = join(app, "openspec", "changes", CHANGE);
  write(join(changeDir, "specs", "calc", "spec.md"), SPEC);
  write(join(changeDir, "tasks.md"), "# Tasks\n\n## 1. Core\n\n- [ ] 1.1 Corrigir a soma\n");
  git(app, "init", "-q");
  git(app, "add", "-A");
  git(app, "commit", "-q", "-m", "inicial");
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(60_000);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

describe("8.1 verificar e arquivar (motor real + LLM simulado)", () => {
  test("registers the mono-repo, runs and accepts task 1.1", async () => {
    await page.goto(`${stack.url}/new`);
    await page.getByLabel("Pasta do projeto").fill(app);
    await page.getByRole("button", { name: "Registrar" }).click();
    await page.getByRole("heading", { name: "app", level: 1 }).waitFor();
    await page.goto(`${page.url()}/changes/${CHANGE}`);
    await page.getByRole("heading", { name: CHANGE, level: 1 }).waitFor();
    await runNext();
    await accept("1.1");
    expect(readFileSync(join(app, "src", "soma.ts"), "utf8")).toContain("a + b");
  });

  test("verificar: CONCERNS, with the covered scenario and the one without a test", async () => {
    await verify("CONCERNS");
    await item("Soma dois números").getByText("coberto").waitFor();
    await item("Soma com zero").getByText("sem teste").waitFor();
    expect(readFileSync(join(app, "openspec", "changes", CHANGE, "verification.md"), "utf8")).toContain("**CONCERNS**");
  });

  test("provar: the existing test fails with the code from before task 1.1, so the proof is forte", async () => {
    await item("Soma dois números").getByRole("button", { name: "Provar", exact: true }).click();
    await item("Soma dois números").getByText("prova forte").waitFor({ timeout: 90_000 });
    // The proof never touches the member.
    expect(readFileSync(join(app, "src", "soma.ts"), "utf8")).toContain("a + b");
  });

  test("gerar task de teste, run and accept it, verify again: PASS", async () => {
    await item("Soma com zero").getByRole("button", { name: "Gerar task de teste", exact: true }).click();
    await panel().getByText("Relatório desatualizado").waitFor();
    await task("2.1").waitFor();
    expect(readFileSync(join(app, "openspec", "changes", CHANGE, "tasks.md"), "utf8")).toContain(
      '- [ ] 2.1 Teste automatizado para o cenário "Soma com zero" (calc / Somar)',
    );
    await runNext();
    await accept("2.1");
    expect(existsSync(join(app, "src", "zero.test.ts"))).toBe(true);
    await verify("PASS");
    await item("Soma com zero").getByText("coberto").waitFor();
  });

  test("arquivar e commitar: the change goes to archive/ with verification.md; the commit has only the archive's files", async () => {
    await panel().getByRole("button", { name: "Arquivar e commitar", exact: true }).click();
    const dialog = page.getByRole("form", { name: "Arquivar e commitar" });
    expect(await dialog.getByLabel("Mensagem do commit").inputValue()).toBe(`archive: ${CHANGE}`);
    await dialog.getByRole("button", { name: "Commitar", exact: true }).click();
    await page.getByRole("heading", { name: "app", level: 1 }).waitFor();

    const archive = join(app, "openspec", "changes", "archive");
    const archived = readdirSync(archive).filter((n) => n.endsWith(`-${CHANGE}`));
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(archive, archived[0]!, "verification.md"), "utf8")).toContain("**PASS**");
    expect(existsSync(join(app, "openspec", "changes", CHANGE))).toBe(false);
    expect(readFileSync(join(app, "openspec", "specs", "calc", "spec.md"), "utf8")).toContain("#### Scenario: Soma com zero");

    expect(git(app, "log", "-1", "--format=%an|%s").trim()).toBe(`Global E2E|archive: ${CHANGE}`);
    const files = git(app, "show", "--no-renames", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.startsWith("openspec/changes/") || f === "openspec/specs/calc/spec.md")).toBe(true);
    expect(files).toContain("openspec/specs/calc/spec.md");
    // The code the tasks changed was accepted without a commit: it stays pending.
    expect(git(app, "status", "--porcelain")).toContain("src/soma.ts");
  });
});
