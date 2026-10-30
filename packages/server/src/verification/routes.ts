import { Hono } from "hono";
import { z } from "zod";
import type { GitFailure } from "@studio/shared";
import { invalidInput } from "../errors.ts";
import { GitActionError } from "../git/exec.ts";
import type { VerificationService } from "./service.ts";

const NoteInput = z.object({ note: z.string().optional() });
const JustifyInput = z.object({ text: z.string() });
const Commit = z.object({ message: z.string().trim().min(1), noVerify: z.boolean().default(false) });
const ArchiveInput = z.object({ commit: Commit.optional() });

/** Verification endpoints (spec: change-verification). */
export function verificationRoutes(service: VerificationService): Hono {
  const r = new Hono();
  const base = "/workspaces/:id/changes/:change/verification";
  const p = (c: { req: { param(k: string): string } }) => [c.req.param("id"), c.req.param("change")] as const;
  // Item ids are `<capability>/<requirement>/<scenario>`: they travel URL-encoded in one segment.
  const item = (c: { req: { param(k: string): string } }) => decodeURIComponent(c.req.param("item"));

  r.get(base, (c) => c.json(service.state(...p(c))));
  r.post(base, async (c) => c.json(await service.run(...p(c)), 202));
  r.delete(base, async (c) => c.json(await service.stop(...p(c))));

  r.post(`${base}/items/:item/check`, async (c) => {
    const input = NoteInput.safeParse(await c.req.json().catch(() => ({})));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(service.check(...p(c), item(c), input.data.note));
  });
  r.delete(`${base}/items/:item/check`, (c) => c.json(service.uncheck(...p(c), item(c))));
  r.put(`${base}/items/:item/justification`, async (c) => {
    const input = JustifyInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(service.justify(...p(c), item(c), input.data.text));
  });
  r.post(`${base}/items/:item/test-task`, (c) => c.json(service.addTestTask(...p(c), item(c))));
  r.post(`${base}/items/:item/proof`, async (c) => c.json(await service.prove(...p(c), item(c)), 202));

  r.post("/workspaces/:id/changes/:change/archive", async (c) => {
    const raw = await c.req.text();
    const input = ArchiveInput.safeParse(raw.trim() ? JSON.parse(raw) : {});
    if (!input.success) return invalidInput(c, input.error.message);
    try {
      return c.json(await service.archive(...p(c), input.data.commit ? { commit: input.data.commit } : {}));
    } catch (err) {
      // The change is archived; only its commit failed, and "Tentar de novo" commits the same files.
      if (err instanceof GitActionError) {
        const body: GitFailure & { archived: true } = {
          error: { code: "git_failed", message: err.message, kind: err.kind, output: err.output },
          archived: true,
        };
        return c.json(body, 422);
      }
      throw err;
    }
  });
  r.post("/workspaces/:id/changes/:change/archive/commit", async (c) => {
    const input = Commit.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json({ commit: await service.commitArchive(...p(c), input.data) });
  });

  return r;
}
