import { Hono } from "hono";
import { z } from "zod";
import { invalidInput } from "../errors.ts";
import { ApplyConfirmationError, type ApplyService } from "./service.ts";

const RunInput = z.object({ mode: z.enum(["proxima", "todas"]), confirmed: z.boolean().default(false) });
const AdjustInput = z.object({ request: z.string().min(3) });
const ReplyInput = z.object({ requestId: z.string().min(1), reply: z.enum(["once", "always", "reject"]) });
const CommandsInput = z.object({ commands: z.array(z.string()) });
const AcceptInput = z.object({
  commit: z.object({ message: z.string().trim().min(1), noVerify: z.boolean().default(false) }).optional(),
});

/** Apply endpoints (spec: change-apply). */
export function applyRoutes(service: ApplyService): Hono {
  const r = new Hono();
  const base = "/workspaces/:id/changes/:change/apply";
  const p = (c: { req: { param(k: string): string } }) => [c.req.param("id"), c.req.param("change")] as const;

  r.get(base, async (c) => c.json(await service.state(...p(c))));
  r.get("/workspaces/:id/apply/check", (c) => c.json({ warnings: service.check(c.req.param("id")) }));

  r.post(`${base}/run`, async (c) => {
    const input = RunInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    try {
      return c.json(await service.run(...p(c), input.data.mode, input.data.confirmed), 202);
    } catch (err) {
      // The UI shows the warnings and asks the user before trying again with `confirmed`.
      if (err instanceof ApplyConfirmationError) {
        return c.json({ error: { code: "conflict", message: err.message }, warnings: err.warnings }, 409);
      }
      throw err;
    }
  });

  r.post(`${base}/stop`, async (c) => c.json(await service.stop(...p(c))));
  r.post(`${base}/tasks/:task/accept`, async (c) => {
    // No body is a plain accept, as before add-git-commits.
    const raw = await c.req.text();
    const input = AcceptInput.safeParse(raw.trim() ? JSON.parse(raw) : {});
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.accept(...p(c), c.req.param("task"), input.data.commit ? { commit: input.data.commit } : {}));
  });
  r.post(`${base}/tasks/:task/undo`, async (c) => c.json(await service.undo(...p(c), c.req.param("task"))));

  r.post(`${base}/tasks/:task/adjust`, async (c) => {
    const input = AdjustInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.adjust(...p(c), c.req.param("task"), input.data.request), 202);
  });

  r.post(`${base}/permission`, async (c) => {
    const input = ReplyInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.reply(...p(c), input.data.requestId, input.data.reply));
  });

  r.get("/workspaces/:id/apply/commands", (c) => c.json({ commands: service.listCommands(c.req.param("id")) }));
  r.put("/workspaces/:id/apply/commands", async (c) => {
    const input = CommandsInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json({ commands: service.setCommands(c.req.param("id"), input.data.commands) });
  });

  return r;
}
