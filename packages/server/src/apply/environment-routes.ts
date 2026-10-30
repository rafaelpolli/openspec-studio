import { Hono } from "hono";
import { z } from "zod";
import { invalidInput } from "../errors.ts";
import type { WorkspaceService } from "../workspaces/service.ts";
import type { EnvironmentStore } from "./environment.ts";
import type { EnvironmentManager } from "./environments.ts";

const ConfigInput = z.object({ mode: z.string().min(1), idleMinutes: z.number() });

/** The workspace's apply environment settings (spec: apply-environment, "Escolher o ambiente do apply"). */
export function environmentRoutes(workspaces: WorkspaceService, store: EnvironmentStore, manager?: EnvironmentManager): Hono {
  const r = new Hono();
  const path = "/workspaces/:id/apply/environment";
  r.get(path, (c) => c.json(store.settings(workspaces.get(c.req.param("id")))));
  r.put(path, async (c) => {
    const input = ConfigInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    const ws = workspaces.get(c.req.param("id"));
    store.set(ws, input.data as Parameters<EnvironmentStore["set"]>[1]);
    return c.json(store.settings(ws));
  });
  if (manager) {
    const ws = (c: { req: { param(k: string): string } }) => workspaces.get(c.req.param("id"));
    r.get(`${path}/status`, (c) => c.json(manager.status(ws(c))));
    r.post(`${path}/stop`, async (c) => c.json(await manager.stop(ws(c))));
    // Preparing can take minutes: answer at once and report progress through events.
    r.post(`${path}/rebuild`, (c) => {
      const w = ws(c);
      void manager.rebuild(w).catch(() => {});
      return c.json(manager.status(w), 202);
    });
  }
  return r;
}
