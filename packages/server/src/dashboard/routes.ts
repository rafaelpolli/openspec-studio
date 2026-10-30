import { ValidateInput } from "@studio/shared";
import { Hono } from "hono";
import { invalidInput } from "../errors.ts";
import type { DashboardService } from "./service.ts";

export function dashboardRoutes(service: DashboardService): Hono {
  const r = new Hono();
  const ws = "/workspaces/:id";

  r.get("/system", async (c) => c.json(await service.system()));
  r.get(`${ws}/specs`, async (c) => c.json(await service.specs(c.req.param("id"))));
  r.get(`${ws}/specs/:spec`, async (c) => c.json(await service.spec(c.req.param("id"), c.req.param("spec"))));
  r.get(`${ws}/changes`, async (c) => c.json(await service.changes(c.req.param("id"))));
  r.get(`${ws}/changes/:change/status`, async (c) =>
    c.json(await service.status(c.req.param("id"), c.req.param("change"))),
  );
  r.get(`${ws}/changes/:change/tasks`, async (c) =>
    c.json(await service.tasks(c.req.param("id"), c.req.param("change"))),
  );
  r.get(`${ws}/changes/:change/artifacts/:artifact`, async (c) =>
    c.json(await service.artifact(c.req.param("id"), c.req.param("change"), c.req.param("artifact"))),
  );
  r.post(`${ws}/validate`, async (c) => {
    const input = ValidateInput.safeParse(await c.req.json().catch(() => ({})));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.validate(c.req.param("id"), input.data.item));
  });

  return r;
}
