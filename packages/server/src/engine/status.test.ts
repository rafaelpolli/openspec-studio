import { afterAll, describe, expect, test } from "bun:test";
import type { EngineStatus, ServerEvent } from "@studio/shared";
import { TOKEN_HEADER } from "@studio/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { EventBus } from "../events.ts";
import { createToken } from "../security.ts";
import { FakeEngine } from "../testing/fake-engine.ts";
import { OpencodeEngine } from "./opencode.ts";
import { EngineStatusService } from "./status.ts";

const dir = mkdtempSync(join(tmpdir(), "studio-engine-status-"));
const real: OpencodeEngine[] = [];
afterAll(async () => {
  await Promise.all(real.map((e) => e.stop()));
  rmSync(dir, { recursive: true, force: true });
});

const token = createToken();
function api(service: EngineStatusService) {
  const app = createApp({ token, allowedOrigins: [], events: new EventBus(), engineStatus: service });
  return async (method: string, path: string) => {
    const res = await app.request(`/api${path}`, { method, headers: { [TOKEN_HEADER]: token } });
    return (await res.json()) as EngineStatus;
  };
}

describe("engine availability (fake engine)", () => {
  test("starting and restarting show as iniciando", async () => {
    const engine = new FakeEngine();
    const service = new EngineStatusService(engine, new EventBus());
    engine.state = "starting";
    expect((await service.status()).availability).toBe("iniciando");
    engine.state = "restarting";
    expect((await service.status()).availability).toBe("iniciando");
  });

  test("Nenhum provedor configurado: only the built-in provider counts as none", async () => {
    const engine = new FakeEngine();
    engine.connected = ["opencode"];
    const status = await new EngineStatusService(engine, new EventBus()).status();
    expect(status).toMatchObject({ availability: "sem_provedor", message: "nenhum provedor de LLM configurado" });
  });

  test("Motor disponível: a user provider makes AI actions available", async () => {
    const engine = new FakeEngine();
    engine.connected = ["opencode", "anthropic"];
    expect((await new EngineStatusService(engine, new EventBus()).status()).availability).toBe("disponivel");
  });

  test("Motor não inicia: failed shows the error; retry restarts it", async () => {
    const engine = new FakeEngine();
    engine.setState("failed", "spawn ENOENT");
    const call = api(new EngineStatusService(engine, new EventBus()));
    expect(await call("GET", "/engine")).toMatchObject({ availability: "falhou", message: "spawn ENOENT" });
    engine.connected = ["anthropic"];
    expect((await call("POST", "/engine/restart")).availability).toBe("disponivel");
  });

  test("state changes are announced to the UI", () => {
    const engine = new FakeEngine();
    const events = new EventBus();
    const seen: ServerEvent[] = [];
    events.subscribe((e) => seen.push(e));
    new EngineStatusService(engine, events);
    engine.setState("restarting");
    engine.emit({ kind: "interrupted" });
    engine.emit({ kind: "idle", sessionId: "s" });
    expect(seen).toEqual([{ type: "engine-changed" }, { type: "engine-changed" }]);
  });
});

describe("engine availability (real engine)", () => {
  test("a fresh engine reports sem_provedor, and disponivel after an API key is saved", async () => {
    const engine = new OpencodeEngine({ dataDir: join(dir, "real") });
    real.push(engine);
    await engine.ensureRunning();
    const call = api(new EngineStatusService(engine, new EventBus()));
    expect(await call("GET", "/engine")).toMatchObject({ availability: "sem_provedor", version: "1.19.4" });

    const { url, authorization } = engine.connection!;
    await fetch(`${url}/auth/anthropic`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ type: "api", key: "sk-fake-for-test" }),
    });
    expect((await call("GET", "/engine")).availability).toBe("disponivel");
  }, 60_000);

  test("a missing binary reports falhou with the error", async () => {
    const engine = new OpencodeEngine({ dataDir: join(dir, "broken"), binary: { path: join(dir, "nope"), version: "1.19.4" } });
    await engine.ensureRunning().catch(() => {});
    const status = await new EngineStatusService(engine, new EventBus()).status();
    expect(status.availability).toBe("falhou");
    expect(status.message).toBeTruthy();
  });
});
