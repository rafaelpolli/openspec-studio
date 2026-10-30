import { ChangeDraft, MessageInput, NewExplorationInput, TitleInput } from "@studio/shared";
import { Hono } from "hono";
import { invalidInput } from "../errors.ts";
import type { ExplorationService } from "./service.ts";

/** Exploration endpoints (spec: workspace-exploration). */
export function explorationRoutes(service: ExplorationService): Hono {
  const r = new Hono();
  const base = "/workspaces/:id/explorations";
  const p = (c: { req: { param(k: string): string } }) => [c.req.param("id"), c.req.param("x")] as const;
  const body = async (c: { req: { text(): Promise<string> } }) => {
    const raw = await c.req.text();
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return null;
    }
  };

  r.get(base, (c) => c.json(service.list(c.req.param("id"))));
  r.post(base, async (c) => {
    const input = NewExplorationInput.safeParse(await body(c));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(service.create(c.req.param("id"), input.data.from), 201);
  });
  r.get(`${base}/:x`, (c) => c.json(service.get(...p(c))));
  r.patch(`${base}/:x`, async (c) => {
    const input = TitleInput.safeParse(await body(c));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(service.rename(...p(c), input.data.title));
  });
  r.post(`${base}/:x/messages`, async (c) => {
    const input = MessageInput.safeParse(await body(c));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.send(...p(c), input.data.text), 202);
  });
  r.post(`${base}/:x/stop`, async (c) => c.json(await service.stop(...p(c))));
  r.post(`${base}/:x/draft`, async (c) => c.json(await service.draft(...p(c)), 202));
  r.post(`${base}/:x/change`, async (c) => {
    const input = ChangeDraft.safeParse(await body(c));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.toChange(...p(c), input.data));
  });
  r.post(`${base}/:x/discard`, (c) => c.json(service.discard(...p(c))));
  return r;
}
