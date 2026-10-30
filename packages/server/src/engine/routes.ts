import { Hono } from "hono";
import type { AgentRunner } from "./runner.ts";
import type { EngineStatusService } from "./status.ts";

export function engineRoutes(status: EngineStatusService, runner?: AgentRunner): Hono {
  const r = new Hono();
  r.get("/engine", async (c) => c.json(await status.status()));
  r.post("/engine/restart", async (c) => c.json(await status.retry()));
  if (runner) {
    const run = "/workspaces/:id/changes/:change/run";
    r.get(run, (c) => c.json(runner.view(c.req.param("id"), c.req.param("change")) ?? null));
    r.post(`${run}/cancel`, async (c) =>
      c.json((await runner.cancel(c.req.param("id"), c.req.param("change"))) ?? null),
    );
  }
  return r;
}
