import { AnswersInput, CreateChangeInput } from "@studio/shared";
import { Hono } from "hono";
import { z } from "zod";
import { invalidInput } from "../errors.ts";
import { suggestChangeName, type ProposalService } from "./service.ts";

const EditInput = z.object({ path: z.string().min(1), content: z.string() });
const AdjustInput = z.object({ request: z.string().min(3) });

export function proposalRoutes(service: ProposalService): Hono {
  const r = new Hono();
  const change = "/workspaces/:id/changes/:change";
  const artifact = `${change}/artifacts/:artifact`;
  const p = (c: { req: { param(k: string): string } }) =>
    [c.req.param("id"), c.req.param("change"), c.req.param("artifact")] as const;

  r.get("/suggest-name", (c) => c.json({ name: suggestChangeName(c.req.query("description") ?? "") }));

  r.post("/workspaces/:id/changes", async (c) => {
    const input = CreateChangeInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.create(c.req.param("id"), input.data.name, input.data.description), 201);
  });

  r.get(`${change}/proposal`, async (c) => c.json(await service.view(c.req.param("id"), c.req.param("change"))));

  r.post(`${artifact}/generate`, async (c) => c.json((await service.generate(...p(c))).run, 202));
  r.post(`${artifact}/fix`, async (c) => c.json((await service.fix(...p(c))).run, 202));
  r.post(`${artifact}/approve`, async (c) => c.json(await service.approve(...p(c))));

  r.put(`${artifact}/content`, async (c) => {
    const input = EditInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.saveEdit(...p(c), input.data.path, input.data.content));
  });

  r.post(`${artifact}/adjust`, async (c) => {
    const input = AdjustInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json((await service.adjust(...p(c), input.data.request)).run, 202);
  });

  // Decisions checkpoint (add-proposal-decisions D8).
  const ch = (c: { req: { param(k: string): string } }) => [c.req.param("id"), c.req.param("change")] as const;
  r.post(`${change}/decisions/answers`, async (c) => {
    const input = AnswersInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.answer(...ch(c), input.data.answers));
  });
  r.post(`${change}/decisions/skip`, async (c) => c.json(await service.skip(...ch(c))));
  r.post(`${change}/decisions/retry`, async (c) => c.json(await service.retryDecisions(...ch(c)), 202));

  r.post(`${change}/generate-rest`, async (c) =>
    c.json(await service.generateRest(c.req.param("id"), c.req.param("change")), 202),
  );

  return r;
}
