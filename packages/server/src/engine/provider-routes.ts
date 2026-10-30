import { Hono } from "hono";
import { z } from "zod";
import { invalidInput } from "../errors.ts";
import type { ProviderService } from "./providers.ts";

const KeyInput = z.object({ key: z.string().min(1) });
const OauthStartInput = z.object({ method: z.number().int().min(0), inputs: z.record(z.string(), z.string()).optional() });
const OauthFinishInput = z.object({ method: z.number().int().min(0), code: z.string().optional() });
const ModelInput = z.object({ model: z.string().regex(/^[^/]+\/.+$/, "use provider/model") });

export function providerRoutes(service: ProviderService): Hono {
  const r = new Hono();
  const body = async <T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T) =>
    schema.safeParse(await c.req.json().catch(() => null));

  r.get("/providers", async (c) => c.json(await service.list()));

  r.put("/providers/:id/key", async (c) => {
    const input = await body(c, KeyInput);
    if (!input.success) return invalidInput(c, input.error.message);
    await service.setApiKey(c.req.param("id"), input.data.key);
    return c.body(null, 204);
  });

  r.delete("/providers/:id", async (c) => c.json(await service.remove(c.req.param("id"))));

  r.post("/providers/:id/oauth/authorize", async (c) => {
    const input = await body(c, OauthStartInput);
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.oauthStart(c.req.param("id"), input.data.method, input.data.inputs));
  });

  r.post("/providers/:id/oauth/callback", async (c) => {
    const input = await body(c, OauthFinishInput);
    if (!input.success) return invalidInput(c, input.error.message);
    await service.oauthFinish(c.req.param("id"), input.data.method, input.data.code);
    return c.body(null, 204);
  });

  r.put("/settings/default-model", async (c) => {
    const input = await body(c, ModelInput);
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.setDefaultModel(input.data.model));
  });

  return r;
}
