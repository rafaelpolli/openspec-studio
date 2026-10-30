import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TOKEN_HEADER, type Exploration } from "@studio/shared";
import { rmSync } from "node:fs";
import { createApp } from "../app.ts";
import { EventBus } from "../events.ts";
import { createToken } from "../security.ts";
import { explorationSetup } from "./testing.ts";

setDefaultTimeout(60_000);

const t = await explorationSetup({ title: "Ideia", draft: { name: "add-ideia", description: "Uma ideia.", decisions: [] } });
afterAll(() => {
  t.close();
  rmSync(t.dir, { recursive: true, force: true });
});
const token = createToken();
const app = createApp({ token, allowedOrigins: [], events: new EventBus(), workspaces: t.workspaces, explorations: t.service });
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api/workspaces/${t.ws.id}/explorations${path}`, {
    method,
    headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as any };
};

describe("3.4 rotas das explorações", () => {
  test("create, list, message, title, draft, change and discard through the API, with 400/404/409", async () => {
    const created = await call("POST", "");
    expect(created.status).toBe(201);
    const id = (created.json as Exploration).id;
    expect((await call("POST", `/${id}/messages`, { text: "  " })).status).toBe(400);
    expect((await call("POST", `/${id}/messages`, { text: "uma ideia" })).status).toBe(202);
    await t.service.settled(id);
    const got = (await call("GET", `/${id}`)).json as Exploration;
    expect([got.title, got.messages.length]).toEqual(["Ideia", 2]);
    expect((await call("PATCH", `/${id}`, { title: "Outro" })).json.title).toBe("Outro");
    expect((await call("GET", "")).json.map((e: Exploration) => e.id)).toEqual([id]);
    expect((await call("POST", `/${id}/draft`)).status).toBe(202);
    await t.service.settled(id);
    expect((await call("POST", `/${id}/change`, { name: "Nome Ruim", description: "x y z", decisions: [] })).status).toBe(400);
    const changed = await call("POST", `/${id}/change`, { name: "add-ideia", description: "Uma ideia.", decisions: [] });
    expect([changed.status, changed.json.status]).toEqual([200, "virou-change"]);
    await t.proposals.settled(t.ws.id, "add-ideia");
    expect((await call("POST", `/${id}/discard`)).status).toBe(409);
    expect((await call("POST", "", { from: id })).status).toBe(201);
    expect((await call("GET", "/nao-existe")).status).toBe(404);
    const other = await app.request(`/api/workspaces/outro/explorations/${id}`, { headers: { [TOKEN_HEADER]: token } });
    expect(other.status).toBe(404);
  });
});
