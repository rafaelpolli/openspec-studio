import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  TOKEN_HEADER,
  type ArchiveOutcome,
  type BaselineReview,
  type CapabilityDraft,
  type Estimate,
  type OnboardingJob,
  type RegisterWorkspaceResult,
} from "@studio/shared";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { AgentRunner } from "../engine/runner.ts";
import { ChangeSessions } from "../engine/sessions.ts";
import { EventBus } from "../events.ts";
import { OpenSpecAdapter } from "../openspec/adapter.ts";
import { createToken } from "../security.ts";
import { sandbox } from "../testing/fixture.ts";
import { onboardingAgent, type OnboardingScript } from "../testing/onboarding-agent.ts";
import { WorkspaceRepo } from "../workspaces/repo.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { WorkspaceWatcher } from "../workspaces/watcher.ts";
import { OnboardingRepo } from "./repo.ts";
import { OnboardingService } from "./service.ts";

// Each baseline goes through several real `openspec` calls.
setDefaultTimeout(90_000);

const { dir, cli } = sandbox("studio-onb-");
const adapter = new OpenSpecAdapter(cli);
const watcher = new WorkspaceWatcher(new EventBus());
afterAll(() => {
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
});

const cap = (name: string, member = "api", path = `src/${name}.ts`): CapabilityDraft => ({
  name,
  description: `Capacidade ${name}.`,
  locations: [{ member, path }],
});

let counter = 0;

function folder(path: string, files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  return path;
}

/** Boots the services over `db` (a new boot over the same file simulates a restart). */
function boot(db: Database, script: OnboardingScript) {
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), adapter, watcher);
  const { engine, stats } = onboardingAgent(script);
  const events = new EventBus();
  const runner = new AgentRunner(engine, new ChangeSessions(db, engine), events);
  const onboarding = new OnboardingService(workspaces, adapter, runner, new OnboardingRepo(db), db, events, {
    workDir: join(dir, "work"),
  });
  const token = createToken();
  const app = createApp({ token, allowedOrigins: [], events, workspaces, onboarding });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: any = await res.json().catch(() => undefined);
    return { status: res.status, json };
  };
  return { onboarding, engine, stats, call, events };
}

/**
 * A brownfield mono-repo (`api`) initialized with OpenSpec, or a multi-repo store
 * with members `repo-api` and `repo-web`.
 */
async function setup(script: OnboardingScript = {}, kind: "mono" | "multi" = "mono") {
  const base = join(dir, `case-${++counter}`);
  const dbFile = join(base, "studio.db");
  mkdirSync(base, { recursive: true });
  const db = openDatabase(dbFile);
  const app = boot(db, script);
  let root: string;
  let body: unknown;
  if (kind === "mono") {
    root = folder(join(base, "api"), { "src/auth.ts": "export const auth = 1;\n", "src/billing.ts": "x\n" });
    await cli.run(["init", "--tools", "none", "--no-animation"], { cwd: root });
    body = { kind: "mono", path: root };
  } else {
    const storeId = `store-${counter}`;
    root = join(base, "store");
    await adapter.storeSetup(base, storeId, root, { initGit: false });
    await cli.run(["init", "--tools", "opencode", "--no-animation"], { cwd: root });
    const api = folder(join(base, "repo-api"), { "src/auth.ts": "export const auth = 1;\n" });
    const web = folder(join(base, "repo-web"), { "src/login.tsx": "export {};\n" });
    body = { kind: "multi", storeId, members: [api, web] };
  }
  const ws = ((await app.call("POST", "/workspaces", body)).json as RegisterWorkspaceResult).workspace;
  const job = async (id: string) => (await app.call("GET", `/onboarding/${id}`)).json as OnboardingJob;
  const statuses = async (id: string) => Object.fromEntries((await job(id)).capabilities.map((c) => [c.name, c.status]));
  /** Discovery → checkpoint with `caps`, then confirmed start. */
  const startBatch = async (caps: CapabilityDraft[]) => {
    const started = (await app.call("POST", `/workspaces/${ws.id}/onboarding`)).json as OnboardingJob;
    await app.onboarding.settled();
    expect((await job(started.id)).status).toBe("checkpoint");
    expect((await app.call("PUT", `/onboarding/${started.id}/capabilities`, { capabilities: caps })).status).toBe(200);
    expect((await app.call("POST", `/onboarding/${started.id}/start`, { confirmed: true })).status).toBe(200);
    return started.id;
  };
  return { ...app, db, dbFile, root, ws, job, statuses, startBatch };
}

describe("8.2 descoberta de capacidades", () => {
  test("Descoberta multi-repo: capabilities may point at one or both members", async () => {
    const discovered = [
      { name: "auth", description: "Login.", locations: [{ member: "repo-api", path: "src/auth.ts" }, { member: "repo-web", path: "src/login.tsx" }] },
      { name: "reports", description: "Relatórios.", locations: [{ member: "repo-api", path: "src" }] },
    ];
    const t = await setup({ discovery: { capabilities: discovered } }, "multi");
    const res = await t.call("POST", `/workspaces/${t.ws.id}/onboarding`);
    expect(res.status).toBe(201);
    expect(res.json.status).toBe("descobrindo");
    await t.onboarding.settled();

    const job = await t.job(res.json.id);
    expect(job.status).toBe("checkpoint");
    expect(job.capabilities.map(({ name, locations }) => ({ name, locations }))).toEqual(
      discovered.map(({ name, locations }) => ({ name, locations })),
    );
    expect(job.capabilities.every((c) => c.status === "aguardando")).toBe(true);
    // The discovery session may write only its own JSON, besides the OpenSpec root.
    const session = [...t.engine.permissions.values()][0]!;
    expect(session).toContainEqual({ permission: "edit", pattern: `${join(dir, "work", job.id)}/**`, action: "allow" });
    expect((await t.call("GET", `/workspaces/${t.ws.id}/onboarding`)).json.id).toBe(job.id);
  });

  test("an invalid discovery result fails the job and can be run again", async () => {
    const t = await setup({ discovery: "{ not json" });
    const first = (await t.call("POST", `/workspaces/${t.ws.id}/onboarding`)).json as OnboardingJob;
    await t.onboarding.settled();
    expect(await t.job(first.id)).toMatchObject({ status: "descoberta_falhou", error: expect.stringContaining("formato") });

    const unknownMember = await setup({ discovery: { capabilities: [cap("auth", "nao-existe")] } });
    const j = (await unknownMember.call("POST", `/workspaces/${unknownMember.ws.id}/onboarding`)).json as OnboardingJob;
    await unknownMember.onboarding.settled();
    expect((await unknownMember.job(j.id)).error).toContain("membro desconhecido");
    expect((await unknownMember.call("POST", `/workspaces/${unknownMember.ws.id}/onboarding`)).status).toBe(201);
  });

  test("refuses discovery before init", async () => {
    const t = await setup();
    const bare = folder(join(dir, `bare-${counter}`), { "main.go": "package main\n" });
    const ws = (await t.call("POST", "/workspaces", { kind: "mono", path: bare })).json.workspace.id;
    expect((await t.call("POST", `/workspaces/${ws}/onboarding`)).status).toBe(409);
  });
});

describe("8.3 checkpoint e estimativa", () => {
  test("Lista ajustada: merged and removed capabilities are what gets generated", async () => {
    const t = await setup({ discovery: { capabilities: [cap("login"), cap("session"), cap("legacy-reports")] } });
    const id = await t.startBatch([
      { name: "auth", description: "Login e sessão.", locations: [...cap("login").locations, ...cap("session").locations] },
    ]);
    await t.onboarding.settled();
    expect(await t.statuses(id)).toEqual({ auth: "pronta" });
    expect(t.stats.prompts.filter((p) => p.startsWith("baseline"))).toEqual(["baseline:auth"]);
    const changes = readdirSync(join(t.root, "openspec", "changes")).filter((n) => n !== "archive");
    expect(changes).toEqual(["baseline-auth"]);
  });

  test("Confirmação: the estimate comes first and the batch starts only when confirmed", async () => {
    const t = await setup({ discovery: { capabilities: [cap("auth"), cap("billing")] } });
    const job = (await t.call("POST", `/workspaces/${t.ws.id}/onboarding`)).json as OnboardingJob;
    await t.onboarding.settled();
    const estimate = (await t.call("GET", `/onboarding/${job.id}/estimate`)).json as Estimate;
    expect(estimate).toMatchObject({ capabilities: 2, files: 2, bytes: 23 + 2, concurrency: 3 });
    expect(estimate.tokens.min).toBeGreaterThan(0);
    expect(estimate.tokens.max).toBeGreaterThan(estimate.tokens.min);

    expect((await t.call("POST", `/onboarding/${job.id}/start`, {})).status).toBe(400);
    expect((await t.job(job.id)).status).toBe("checkpoint");
    expect((await t.call("POST", `/onboarding/${job.id}/start`, { confirmed: true })).json.status).toBe("gerando");
    await t.onboarding.settled();
  });

  test("rejects a list with a repeated or non-kebab name, and an estimate cannot escape a member", async () => {
    const t = await setup({ discovery: { capabilities: [cap("auth")] } });
    const job = (await t.call("POST", `/workspaces/${t.ws.id}/onboarding`)).json as OnboardingJob;
    await t.onboarding.settled();
    const put = (capabilities: unknown) => t.call("PUT", `/onboarding/${job.id}/capabilities`, { capabilities });
    expect((await put([cap("auth"), cap("auth")])).status).toBe(400);
    expect((await put([{ ...cap("auth"), name: "Auth Login" }])).status).toBe(400);
    expect((await put([cap("auth", "api", "../../..")])).status).toBe(200);
    expect(((await t.call("GET", `/onboarding/${job.id}/estimate`)).json as Estimate).files).toBe(0);
  });
});

describe("8.4 executor", () => {
  test("Falha isolada: billing fails, auth and export are ready, billing can be retried", async () => {
    const script: OnboardingScript = { fail: new Set(["billing"]) };
    const t = await setup(script);
    const id = await t.startBatch([cap("auth"), cap("billing"), cap("export")]);
    await t.onboarding.settled();
    expect(await t.statuses(id)).toEqual({ auth: "pronta", billing: "falhou", export: "pronta" });
    const job = await t.job(id);
    expect(job.status).toBe("revisao");
    expect(job.capabilities.find((c) => c.name === "billing")!.error).toContain("autenticação");

    script.fail!.clear();
    expect((await t.call("POST", `/onboarding/${id}/capabilities/billing/retry`)).status).toBe(200);
    await t.onboarding.settled();
    expect(await t.statuses(id)).toEqual({ auth: "pronta", billing: "pronta", export: "pronta" });
  });

  test("an invalid baseline fails validation with the CLI's message", async () => {
    const t = await setup({ invalid: new Set(["auth"]) });
    const id = await t.startBatch([cap("auth")]);
    await t.onboarding.settled();
    const auth = (await t.job(id)).capabilities[0]!;
    expect(auth).toMatchObject({ status: "falhou", error: expect.stringContaining("openspec validate") });
  });

  test("a tasks.md written by the agent is removed and the baseline is still ready (D9)", async () => {
    const t = await setup({ tasks: new Set(["auth"]) });
    const id = await t.startBatch([cap("auth")]);
    await t.onboarding.settled();
    expect((await t.job(id)).capabilities[0]).toMatchObject({ status: "pronta", error: null });
    const changeDir = join(t.root, "openspec", "changes", "baseline-auth");
    expect(existsSync(join(changeDir, "tasks.md"))).toBe(false);
    expect(existsSync(join(changeDir, "design.md"))).toBe(true);
  });

  test("a spec without ## Purpose fails, so archive does not write a TBD placeholder (D9)", async () => {
    const script: OnboardingScript = { noPurpose: new Set(["auth"]) };
    const t = await setup(script);
    const id = await t.startBatch([cap("auth")]);
    await t.onboarding.settled();
    expect((await t.job(id)).capabilities[0]).toMatchObject({ status: "falhou", error: expect.stringContaining("## Purpose") });

    script.noPurpose!.clear();
    expect((await t.call("POST", `/onboarding/${id}/capabilities/auth/retry`)).status).toBe(200);
    await t.onboarding.settled();
    expect((await t.job(id)).capabilities[0]).toMatchObject({ status: "pronta", error: null });
  });

  test("runs at most the configured number of sessions at once", async () => {
    const t = await setup({ delayMs: 150 });
    expect((await t.call("PUT", "/settings/onboarding-concurrency", { value: 2 })).json).toEqual({ value: 2 });
    const id = await t.startBatch([cap("a1"), cap("a2"), cap("a3"), cap("a4"), cap("a5")]);
    await t.onboarding.settled();
    expect(Object.values(await t.statuses(id))).toEqual(Array(5).fill("pronta"));
    expect(t.stats.maxActive).toBe(2);
  });

  test("cancels one capability without touching the others", async () => {
    const t = await setup({ hang: new Set(["auth"]) });
    const id = await t.startBatch([cap("auth"), cap("export")]);
    while (!t.stats.prompts.includes("baseline:auth")) await Bun.sleep(20);
    expect((await t.call("POST", `/onboarding/${id}/capabilities/auth/cancel`)).status).toBe(200);
    await t.onboarding.settled();
    expect(await t.statuses(id)).toEqual({ auth: "cancelada", export: "pronta" });
    expect((await t.job(id)).status).toBe("revisao");
  });

  test("resumes after a restart: interrupted capabilities return to the queue", async () => {
    const t = await setup({ hang: new Set(["auth", "export"]) });
    const id = await t.startBatch([cap("auth"), cap("export")]);
    while (t.stats.prompts.length < 2) await Bun.sleep(20);
    expect(await t.statuses(id)).toEqual({ auth: "gerando", export: "gerando" });

    // A new backend over the same database, with an agent that finishes.
    const restarted = boot(openDatabase(t.dbFile), {});
    restarted.onboarding.start();
    await Bun.sleep(0);
    await restarted.onboarding.settled();
    expect(Object.fromEntries((await restarted.onboarding.job(id)).capabilities.map((c) => [c.name, c.status]))).toEqual({
      auth: "pronta",
      export: "pronta",
    });
  });
});

describe("8.6 / 8.7 revisão e archive", () => {
  test("review shows the requirements with their evidence and the inferido badge", async () => {
    const t = await setup();
    const id = await t.startBatch([cap("auth")]);
    await t.onboarding.settled();
    const review = (await t.call("GET", `/onboarding/${id}/capabilities/auth/review`)).json as BaselineReview;
    expect(review.change).toBe("baseline-auth");
    expect(review.requirements).toEqual([
      {
        name: "Validar credenciais",
        text: "O sistema SHALL recusar credenciais inválidas em auth.",
        evidence: ["api/src/auth.ts:12", "api/test/auth.test.ts:5"],
        inferred: false,
      },
      { name: "Registrar tentativas", text: "O sistema SHALL registrar cada tentativa de auth.", evidence: ["api/src/auth.ts:40"], inferred: true },
    ]);
    expect(review.files.map((f) => f.path).sort()).toEqual(["design.md", "proposal.md", "specs/auth/spec.md"]);
  });

  test("adjust returns the baseline to review; Descartar removes only that change", async () => {
    const t = await setup();
    const id = await t.startBatch([cap("auth"), cap("export")]);
    await t.onboarding.settled();
    expect((await t.call("POST", `/onboarding/${id}/capabilities/auth/adjust`, { request: "detalhe mais" })).json.capabilities[0].status).toBe("gerando");
    await t.onboarding.settled();
    const review = (await t.call("GET", `/onboarding/${id}/capabilities/auth/review`)).json as BaselineReview;
    expect(review.files.find((f) => f.path === "design.md")!.content).toContain("Ajustado conforme pedido.");
    expect((await t.job(id)).capabilities[0]!.status).toBe("pronta");

    expect((await t.call("POST", `/onboarding/${id}/capabilities/export/discard`)).status).toBe(200);
    expect(existsSync(join(t.root, "openspec/changes/baseline-export"))).toBe(false);
    expect(existsSync(join(t.root, "openspec/changes/baseline-auth"))).toBe(true);
    expect(await t.statuses(id)).toEqual({ auth: "pronta", export: "descartada" });
  });

  test("Archive parcial: only approved baselines are archived", async () => {
    const t = await setup();
    const id = await t.startBatch([cap("auth"), cap("billing")]);
    await t.onboarding.settled();
    expect((await t.call("POST", `/onboarding/${id}/capabilities/auth/approve`)).status).toBe(200);
    const outcomes = (await t.call("POST", `/onboarding/${id}/archive`)).json as ArchiveOutcome[];
    expect(outcomes).toEqual([{ capability: "auth", change: "baseline-auth", ok: true }]);
    expect(existsSync(join(t.root, "openspec/specs/auth/spec.md"))).toBe(true);
    expect((await adapter.listChanges({ cwd: t.root })).map((c) => c.name)).toEqual(["baseline-billing"]);
    expect(await t.statuses(id)).toEqual({ auth: "arquivada", billing: "pronta" });
  });

  test("Falha no archive de uma baseline: the others are archived and the failure is shown", async () => {
    const t = await setup();
    const id = await t.startBatch([cap("auth"), cap("billing"), cap("export")]);
    await t.onboarding.settled();
    for (const c of ["auth", "billing", "export"]) await t.call("POST", `/onboarding/${id}/capabilities/${c}/approve`);
    rmSync(join(t.root, "openspec/changes/baseline-billing"), { recursive: true });

    const outcomes = (await t.call("POST", `/onboarding/${id}/archive`)).json as ArchiveOutcome[];
    expect(outcomes.map((o) => [o.capability, o.ok])).toEqual([
      ["auth", true],
      ["billing", false],
      ["export", true],
    ]);
    expect(outcomes[1]!.error).toBeTruthy();
    expect(existsSync(join(t.root, "openspec/specs/auth/spec.md"))).toBe(true);
    expect(existsSync(join(t.root, "openspec/specs/export/spec.md"))).toBe(true);
    const billing = (await t.job(id)).capabilities.find((c) => c.name === "billing")!;
    expect(billing).toMatchObject({ status: "aprovada", error: expect.stringContaining("archive falhou") });
  });
});
