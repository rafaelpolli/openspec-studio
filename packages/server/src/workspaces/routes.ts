import { CreateStoreInput, InitInput, RegisterWorkspaceInput } from "@studio/shared";
import { Hono } from "hono";
import { invalidInput } from "../errors.ts";
import type { WorkspaceService } from "./service.ts";

export function workspaceRoutes(service: WorkspaceService): Hono {
  const r = new Hono();

  r.get("/workspaces", (c) => c.json(service.list()));

  r.post("/workspaces", async (c) => {
    const input = RegisterWorkspaceInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.register(input.data), 201);
  });

  r.get("/workspaces/:id", (c) => c.json(service.view(c.req.param("id"))));

  r.delete("/workspaces/:id", (c) => {
    service.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  r.post("/workspaces/:id/init", async (c) => {
    const input = InitInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.initialize(c.req.param("id"), input.data.language));
  });

  r.get("/workspaces/:id/issues", async (c) => c.json(await service.memberIssues(service.get(c.req.param("id")))));

  r.post("/workspaces/:id/members/:member/declare-store", (c) => {
    service.declareStore(c.req.param("id"), c.req.param("member"));
    return c.body(null, 204);
  });

  r.get("/workspaces/:id/file", (c) => {
    const path = c.req.query("path");
    if (!path) return invalidInput(c, "missing 'path' query parameter");
    return c.text(service.readFile(c.req.param("id"), path));
  });

  r.post("/stores", async (c) => {
    const input = CreateStoreInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalidInput(c, input.error.message);
    return c.json(await service.createStore(input.data.id, input.data.path, input.data.initGit), 201);
  });

  return r;
}
