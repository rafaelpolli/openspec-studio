import type { ServerEvent } from "@studio/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { environmentRoutes } from "./apply/environment-routes.ts";
import type { EnvironmentStore } from "./apply/environment.ts";
import type { EnvironmentManager } from "./apply/environments.ts";
import { applyRoutes } from "./apply/routes.ts";
import type { ApplyService } from "./apply/service.ts";
import { dashboardRoutes } from "./dashboard/routes.ts";
import type { DashboardService } from "./dashboard/service.ts";
import { providerRoutes } from "./engine/provider-routes.ts";
import type { ProviderService } from "./engine/providers.ts";
import { engineRoutes } from "./engine/routes.ts";
import { gitRoutes } from "./git/routes.ts";
import type { GitService } from "./git/service.ts";
import { verificationRoutes } from "./verification/routes.ts";
import { explorationRoutes } from "./explore/routes.ts";
import type { ExplorationService } from "./explore/service.ts";
import type { VerificationService } from "./verification/service.ts";
import { onboardingRoutes } from "./onboarding/routes.ts";
import type { OnboardingService } from "./onboarding/service.ts";
import { proposalRoutes } from "./proposal/routes.ts";
import type { ProposalService } from "./proposal/service.ts";
import type { AgentRunner } from "./engine/runner.ts";
import type { EngineStatusService } from "./engine/status.ts";
import { errorResponse } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { guard } from "./security.ts";
import { uiRoutes } from "./ui.ts";
import { workspaceRoutes } from "./workspaces/routes.ts";
import type { WorkspaceService } from "./workspaces/service.ts";

export interface AppDeps {
  token: string;
  allowedOrigins: readonly string[];
  events: EventBus;
  workspaces?: WorkspaceService;
  dashboard?: DashboardService;
  engineStatus?: EngineStatusService;
  runner?: AgentRunner;
  providers?: ProviderService;
  proposals?: ProposalService;
  onboarding?: OnboardingService;
  apply?: ApplyService;
  environments?: EnvironmentStore;
  environmentManager?: EnvironmentManager;
  git?: GitService;
  verification?: VerificationService;
  explorations?: ExplorationService;
  /** Built UI to serve (production `bun run start`); the dev setup uses Vite instead. */
  ui?: { dir: string; allowedHosts: readonly string[] };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono();

  api.use("*", guard({ token: deps.token, allowedOrigins: deps.allowedOrigins }));

  api.get("/health", (c) => c.json({ ok: true }));

  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: ServerEvent) =>
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      const queue: ServerEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = deps.events.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await send({ type: "hello" });
      while (!stream.aborted) {
        const next = queue.shift();
        if (next) {
          await send(next);
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      unsubscribe();
    }),
  );

  if (deps.workspaces) api.route("/", workspaceRoutes(deps.workspaces));
  if (deps.dashboard) api.route("/", dashboardRoutes(deps.dashboard));
  if (deps.engineStatus) api.route("/", engineRoutes(deps.engineStatus, deps.runner));
  if (deps.providers) api.route("/", providerRoutes(deps.providers));
  if (deps.proposals) api.route("/", proposalRoutes(deps.proposals));
  if (deps.onboarding) api.route("/", onboardingRoutes(deps.onboarding));
  if (deps.apply) api.route("/", applyRoutes(deps.apply));
  if (deps.git) api.route("/", gitRoutes(deps.git));
  if (deps.verification) api.route("/", verificationRoutes(deps.verification));
  if (deps.explorations) api.route("/", explorationRoutes(deps.explorations));
  if (deps.environments && deps.workspaces) api.route("/", environmentRoutes(deps.workspaces, deps.environments, deps.environmentManager));

  app.onError(errorResponse);
  app.route("/api", api);
  if (deps.ui) app.route("/", uiRoutes({ ...deps.ui, token: deps.token }));
  return app;
}
