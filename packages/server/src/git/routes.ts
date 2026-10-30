import { Hono } from "hono";
import { z } from "zod";
import { invalidInput } from "../errors.ts";
import type { GitService } from "./service.ts";

const IdentityInput = z.object({ area: z.string().min(1), name: z.string().trim().min(1), email: z.string().trim().min(3).includes("@") });
const AreaInput = z.object({ area: z.string().min(1) });
const CommitInput = z.object({ area: z.string().min(1), message: z.string().trim().min(1), noVerify: z.boolean().default(false) });
const PreviewInput = z.object({ area: z.string().min(1), gitignore: z.string().optional() });
const InitInput = z.object({
  area: z.string().min(1),
  gitignore: z.string(),
  message: z.string().trim().min(1),
  noVerify: z.boolean().default(false),
  identity: z.object({ name: z.string().trim().min(1), email: z.string().trim().includes("@") }).optional(),
});

/** Git endpoints of a workspace (spec: git-repositories). */
export function gitRoutes(service: GitService): Hono {
  const r = new Hono();
  const base = "/workspaces/:id/git";
  const id = (c: { req: { param(k: string): string } }) => c.req.param("id");

  r.get(base, async (c) => c.json(await service.state(id(c))));

  r.put(`${base}/identity`, async (c) => {
    const input = IdentityInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.setIdentity(id(c), input.data.area, input.data.name, input.data.email));
  });

  r.delete(`${base}/identity`, async (c) => {
    const input = AreaInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.clearIdentity(id(c), input.data.area));
  });

  r.post(`${base}/init/preview`, async (c) => {
    const input = PreviewInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.previewInit(id(c), input.data.area, input.data.gitignore));
  });

  r.post(`${base}/init`, async (c) => {
    const input = InitInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    const { area, identity, ...opts } = input.data;
    return c.json(await service.init(id(c), area, { ...opts, ...(identity ? { identity } : {}) }));
  });

  r.post(`${base}/commit-pending`, async (c) => {
    const input = CommitInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    const { area, ...opts } = input.data;
    return c.json(await service.commitPending(id(c), area, opts));
  });

  return r;
}
