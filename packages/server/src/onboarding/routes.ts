import { AdjustInput, CheckpointInput, StartInput } from "@studio/shared";
import { Hono } from "hono";
import { z } from "zod";
import { invalidInput } from "../errors.ts";
import type { OnboardingService } from "./service.ts";

const Concurrency = z.object({ value: z.number().int() });

export function onboardingRoutes(service: OnboardingService): Hono {
  const r = new Hono();
  const job = "/onboarding/:job";
  const cap = `${job}/capabilities/:cap`;

  r.get("/workspaces/:id/onboarding", (c) => c.json(service.current(c.req.param("id"))));
  r.post("/workspaces/:id/onboarding", async (c) => c.json(await service.discover(c.req.param("id")), 201));

  r.get(job, (c) => c.json(service.job(c.req.param("job"))));

  r.put(`${job}/capabilities`, async (c) => {
    const input = CheckpointInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(service.saveCheckpoint(c.req.param("job"), input.data.capabilities));
  });

  r.get(`${job}/estimate`, (c) => c.json(service.estimate(c.req.param("job"))));

  r.post(`${job}/start`, async (c) => {
    const input = StartInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, "confirme a estimativa antes de iniciar a geração");
    return c.json(service.startBatch(c.req.param("job")));
  });

  r.post(`${job}/archive`, async (c) => c.json(await service.archive(c.req.param("job"))));

  r.post(`${cap}/retry`, (c) => c.json(service.retry(c.req.param("job"), c.req.param("cap"))));
  r.post(`${cap}/cancel`, async (c) => c.json(await service.cancel(c.req.param("job"), c.req.param("cap"))));
  r.get(`${cap}/review`, async (c) => c.json(await service.review(c.req.param("job"), c.req.param("cap"))));
  r.post(`${cap}/approve`, (c) => c.json(service.approve(c.req.param("job"), c.req.param("cap"))));
  r.post(`${cap}/discard`, (c) => c.json(service.discard(c.req.param("job"), c.req.param("cap"))));
  r.post(`${cap}/adjust`, async (c) => {
    const input = AdjustInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.adjust(c.req.param("job"), c.req.param("cap"), input.data.request));
  });

  r.get("/settings/onboarding-concurrency", (c) => c.json({ value: service.concurrency }));
  r.put("/settings/onboarding-concurrency", async (c) => {
    const input = Concurrency.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json({ value: service.setConcurrency(input.data.value) });
  });

  return r;
}
