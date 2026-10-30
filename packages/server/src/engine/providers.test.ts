import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOKEN_HEADER, type EngineStatus, type ProvidersResponse } from "@studio/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { openDatabase } from "../db.ts";
import { EventBus } from "../events.ts";
import { createToken } from "../security.ts";
import { OpencodeEngine } from "./opencode.ts";
import { ProviderService } from "./providers.ts";
import { EngineStatusService } from "./status.ts";

const SECRET = "sk-ant-api03-SECRET-test-key-do-not-leak";
const dir = mkdtempSync(join(tmpdir(), "studio-providers-"));
const db = openDatabase(":memory:");
let service: ProviderService;
const engine = new OpencodeEngine({ dataDir: join(dir, "engine"), config: () => service.engineConfig() });
const active = { activeCount: 0 };
service = new ProviderService(engine, db, active);
const token = createToken();
const app = createApp({
  token,
  allowedOrigins: [],
  events: new EventBus(),
  engineStatus: new EngineStatusService(engine, new EventBus()),
  providers: service,
});
const bodies: string[] = [];

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

beforeAll(() => engine.ensureRunning(), 60_000);
afterAll(async () => {
  await engine.stop();
  rmSync(dir, { recursive: true, force: true });
});

const anthropic = (r: ProvidersResponse) => r.providers.find((p) => p.id === "anthropic")!;

describe("providers (real engine, fake key)", () => {
  test("lists providers with auth methods; the built-in provider is hidden", async () => {
    const { json } = await call("GET", "/providers");
    const res = json as ProvidersResponse;
    expect(res.defaultModel).toBeNull();
    expect(res.providers.some((p) => p.id === "opencode")).toBe(false);
    expect(anthropic(res)).toMatchObject({ configured: false, models: [] });
    expect(anthropic(res).methods.length).toBeGreaterThan(0);
    expect(((await call("GET", "/engine")).json as EngineStatus).availability).toBe("sem_provedor");
  }, 60_000);

  test("Chave de API: saving a key marks the provider configured and enables AI", async () => {
    expect((await call("PUT", "/providers/anthropic/key", { key: SECRET })).status).toBe(204);
    const res = (await call("GET", "/providers")).json as ProvidersResponse;
    expect(anthropic(res).configured).toBe(true);
    expect(anthropic(res).models.length).toBeGreaterThan(0);
    expect(res.providers[0]!.id).toBe("anthropic"); // configured providers come first
    expect(((await call("GET", "/engine")).json as EngineStatus).availability).toBe("disponivel");
  }, 60_000);

  test("Escolher modelo padrão: stored, injected into the engine config, applied by restart", async () => {
    const res = (await call("GET", "/providers")).json as ProvidersResponse;
    const model = `anthropic/${anthropic(res).models[0]!.id}`;
    const pidBefore = engine.pid;
    const set = await call("PUT", "/settings/default-model", { model });
    expect(set.json).toEqual({ applied: true });
    expect(engine.pid).not.toBe(pidBefore);
    expect(((await call("GET", "/providers")).json as ProvidersResponse).defaultModel).toBe(model);

    const { url, authorization } = engine.connection!;
    const config = (await (await fetch(`${url}/config`, { headers: { authorization } })).json()) as { model?: string };
    expect(config.model).toBe(model);

    expect((await call("PUT", "/settings/default-model", { model: "anthropic/not-a-model" })).status).toBe(400);
    expect((await call("PUT", "/settings/default-model", { model: "openai/gpt-x" })).status).toBe(400);
  }, 60_000);

  test("while an agent is working, a model change waits for the next restart", async () => {
    const res = (await call("GET", "/providers")).json as ProvidersResponse;
    const model = `anthropic/${anthropic(res).models.at(-1)!.id}`;
    active.activeCount = 1;
    const pid = engine.pid;
    expect((await call("PUT", "/settings/default-model", { model })).json).toEqual({ applied: false });
    expect(engine.pid).toBe(pid);
    active.activeCount = 0;
  }, 60_000);

  test("Remover: the provider becomes not configured and its default model is cleared", async () => {
    const removed = await call("DELETE", "/providers/anthropic");
    expect(removed.json).toEqual({ applied: true });
    const res = (await call("GET", "/providers")).json as ProvidersResponse;
    expect(anthropic(res).configured).toBe(false);
    expect(res.defaultModel).toBeNull();
    expect(((await call("GET", "/engine")).json as EngineStatus).availability).toBe("sem_provedor");
  }, 60_000);

  test("invalid input is rejected", async () => {
    expect((await call("PUT", "/providers/anthropic/key", { key: "   " })).status).toBe(400);
    expect((await call("PUT", "/providers/no-such-provider/key", { key: "k" })).status).toBe(400);
    expect((await call("PUT", "/providers/anthropic/key", {})).status).toBe(400);
  }, 60_000);

  test("Proteger credenciais: no response ever contained the secret", () => {
    expect(bodies.length).toBeGreaterThan(10);
    for (const body of bodies) expect(body).not.toContain(SECRET);
  });
});

describe("ProviderService response shape", () => {
  test("drops credential fields even when the engine catalog includes them", async () => {
    const leaky = {
      providerCatalog: async () => ({
        all: [
          {
            id: "acme",
            name: "Acme",
            source: "config" as const,
            env: ["ACME_KEY"],
            key: SECRET,
            options: { apiKey: SECRET },
            models: { m1: { id: "m1", name: "Model 1", headers: { authorization: SECRET } } },
          },
        ],
        connected: ["acme"],
        methods: { acme: [{ type: "api" as const, label: "API key" }] },
      }),
      setApiKey: async () => {},
      removeAuth: async () => {},
      oauthAuthorize: async () => ({ url: "", method: "auto" as const, instructions: "" }),
      oauthCallback: async () => true,
      restart: async () => {},
    };
    const svc = new ProviderService(leaky as never, openDatabase(":memory:"), { activeCount: 0 });
    const res = await svc.list();
    expect(res.providers).toEqual([
      { id: "acme", name: "Acme", configured: true, methods: [{ index: 0, type: "api", label: "API key" }], models: [{ id: "m1", name: "Model 1" }] },
    ]);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });
});
