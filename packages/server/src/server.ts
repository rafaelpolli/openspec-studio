import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app.ts";
import { CommandList } from "./apply/commands.ts";
import { EnvironmentStore } from "./apply/environment.ts";
import { binaryCacheDir, containerEngineFactory, EngineRegistry } from "./apply/engines.ts";
import { EnvironmentManager } from "./apply/environments.ts";
import { ApplyRepo } from "./apply/repo.ts";
import { ApplyService } from "./apply/service.ts";
import { dataDir, dbPath, HOSTNAME } from "./config.ts";
import { DashboardService } from "./dashboard/service.ts";
import { openDatabase } from "./db.ts";
import type { Engine } from "./engine/engine.ts";
import { OpencodeEngine } from "./engine/opencode.ts";
import { bundledBinary } from "./engine/process.ts";
import { ProviderService } from "./engine/providers.ts";
import { AgentRunner } from "./engine/runner.ts";
import { ChangeSessions } from "./engine/sessions.ts";
import { EngineStatusService } from "./engine/status.ts";
import { EventBus } from "./events.ts";
import { GitClient } from "./git/exec.ts";
import { GitService } from "./git/service.ts";
import { VerificationRepo } from "./verification/repo.ts";
import { ExplorationRepo } from "./explore/repo.ts";
import { ExplorationService } from "./explore/service.ts";
import { VerificationService } from "./verification/service.ts";
import { OpenSpecAdapter } from "./openspec/adapter.ts";
import { OpenSpecCli } from "./openspec/cli.ts";
import { OnboardingRepo } from "./onboarding/repo.ts";
import { OnboardingService } from "./onboarding/service.ts";
import { ProposalService } from "./proposal/service.ts";
import { createToken } from "./security.ts";
import { hasBuiltUi } from "./ui.ts";
import { WorkspaceRepo } from "./workspaces/repo.ts";
import { WorkspaceService } from "./workspaces/service.ts";
import { WorkspaceWatcher } from "./workspaces/watcher.ts";

export interface ServerOptions {
  port?: number;
  /** Replaces the embedded OpenCode engine (E2E tests use a scripted agent). */
  engine?: Engine;
  /** Extra OpenCode config for the embedded engine (the apply E2E test points it at a simulated LLM). */
  engineConfig?: () => Record<string, unknown>;
}

/** Wires every service, starts HTTP and the engine, and installs shutdown handlers. */
export async function startServer(opts: ServerOptions = {}) {
  const token = createToken();
  const events = new EventBus();
  const db = openDatabase(dbPath());
  const openspec = new OpenSpecAdapter(new OpenSpecCli());
  const watcher = new WorkspaceWatcher(events);
  const workspaces = new WorkspaceService(new WorkspaceRepo(db), openspec, watcher);
  workspaces.start();
  const dashboard = new DashboardService(workspaces, openspec);

  // The provider service reads the default model from the database when the engine (re)starts.
  let providers: ProviderService | undefined;
  const engine: Engine =
    opts.engine ??
    new OpencodeEngine({
      dataDir: join(dataDir(), "opencode"),
      config: () => ({ ...(providers?.engineConfig() ?? {}), ...(opts.engineConfig?.() ?? {}) }),
      interactive: (sessionId): boolean => sessions.isApply(sessionId),
    });
  const engineStatus = new EngineStatusService(engine, events);
  const sessions = new ChangeSessions(db, engine);
  const runner = new AgentRunner(engine, sessions, events);
  if (engine instanceof OpencodeEngine) providers = new ProviderService(engine, db, runner);
  const proposals = new ProposalService(workspaces, openspec, runner, db);
  proposals.start();
  const explorations = new ExplorationService(workspaces, runner, new ExplorationRepo(db), events, {
    workDir: join(dataDir(), "explore"),
    context: async (ws) => ({
      specs: await dashboard.specs(ws.id).catch(() => []),
      changes: (await openspec.listChanges({ cwd: ws.rootPath, store: ws.storeId ?? undefined }).catch(() => [])).map((c) => c.name),
    }),
    proposals,
  });
  explorations.start();
  const onboarding = new OnboardingService(workspaces, openspec, runner, new OnboardingRepo(db), db, events, {
    workDir: join(dataDir(), "onboarding"),
  });
  onboarding.start();
  const environments = new EnvironmentStore(db);
  const environmentsDir = join(dataDir(), "environments");
  const environmentManager = new EnvironmentManager(environments, events, {
    dataDir: environmentsDir,
    cliPath: Bun.resolveSync("@devcontainers/cli/devcontainer.js", import.meta.dir),
  });
  environmentManager.start();
  void environmentManager.recover(workspaces.list()).catch(() => {});
  const engines = new EngineRegistry(
    runner,
    environments,
    environmentManager,
    db,
    events,
    containerEngineFactory({
      manager: environmentManager,
      authFile: join(dataDir(), "opencode", "data", "opencode", "auth.json"),
      version: bundledBinary().version,
      cacheDir: binaryCacheDir(environmentsDir),
      config: () => ({ ...(providers?.engineConfig() ?? {}), ...(opts.engineConfig?.() ?? {}) }),
    }),
  );
  const applyRepo = new ApplyRepo(db);
  // The verification is created after the apply, which asks it whether a change is being verified.
  let verification: VerificationService | undefined;
  const verifying = (id: string) => verification?.busy(id) ?? false;
  const apply = new ApplyService(workspaces, openspec, engines, applyRepo, new CommandList(db), new GitClient(), verifying);
  apply.start();
  verification = new VerificationService(workspaces, runner, environmentManager, new VerificationRepo(db), applyRepo, events, {
    workDir: join(dataDir(), "verify"),
    applyBusy: (id) => apply.busy(id),
    // Under the engine folder, which the apply container already mounts at the same path.
    proofDir: (id) => join(environmentManager.engineDir(id), "verify"),
    openspec,
  });
  verification.start();
  const git = new GitService(workspaces, new GitClient(), events, (id) => apply.busy(id), verifying);
  // Start in the background; the UI shows "iniciando" until it is up, and "falhou" if it cannot start.
  engine.ensureRunning().catch((err) => console.warn(`warning: engine did not start: ${(err as Error).message}`));

  try {
    await openspec.cli.assertVersion();
  } catch (err) {
    console.warn(`warning: ${(err as Error).message}`);
  }

  // Filled after the server binds, since port 0 lets the OS choose the port.
  const origins: string[] = [];
  const hosts: string[] = [];
  const uiDir = process.env.STUDIO_UI_DIR ?? resolve(import.meta.dir, "../../web/dist");
  const app = createApp({
    token,
    allowedOrigins: origins,
    events,
    workspaces,
    dashboard,
    engineStatus,
    runner,
    proposals,
    onboarding,
    apply,
    git,
    verification,
    explorations,
    environments,
    environmentManager,
    ...(hasBuiltUi(uiDir) ? { ui: { dir: uiDir, allowedHosts: hosts } } : {}),
    ...(providers ? { providers } : {}),
  });
  const server = Bun.serve({ hostname: HOSTNAME, port: opts.port ?? 4317, fetch: app.fetch, idleTimeout: 0 });

  origins.push(`http://${HOSTNAME}:${server.port}`, `http://localhost:${server.port}`);
  hosts.push(`${HOSTNAME}:${server.port}`, `localhost:${server.port}`);
  if (process.env.STUDIO_DEV_ORIGIN) origins.push(process.env.STUDIO_DEV_ORIGIN);

  const url = `http://${HOSTNAME}:${server.port}`;
  // Lets local tooling (the Vite dev server) find this run's URL and token; owner-only.
  const runFile = join(dataDir(), "run.json");
  writeFileSync(runFile, JSON.stringify({ url, token }), { mode: 0o600 });
  chmodSync(runFile, 0o600);

  console.log(`openspec-studio listening on ${url}`);
  if (hasBuiltUi(uiDir)) console.log(`open ${url} in your browser`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      server.stop();
      watcher.close();
      await engine.stop();
      await engines.stopAll();
      environmentManager.close();
      rmSync(runFile, { force: true });
      db.close();
      process.exit(0);
    });
  }
  // Last resort if the backend exits another way: never leave the engine running.
  process.on("exit", () => {
    const pid = engine instanceof OpencodeEngine ? engine.pid : undefined;
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  });

  return { url, token, server };
}
