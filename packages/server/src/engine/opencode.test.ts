import { afterAll, describe, expect, test } from "bun:test";
import type { EngineEvent } from "./engine.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPermissions } from "./guard.ts";
import { OpencodeEngine, toAgentEvent } from "./opencode.ts";
import { bundledBinary, engineEnv, spawnServer, stopServer } from "./process.ts";

const dir = mkdtempSync(join(tmpdir(), "studio-engine-"));
const engines: OpencodeEngine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((e) => e.stop()));
  rmSync(dir, { recursive: true, force: true });
});

function engine(name: string, extra: Partial<ConstructorParameters<typeof OpencodeEngine>[0]> = {}) {
  const e = new OpencodeEngine({ dataDir: join(dir, name), ...extra });
  engines.push(e);
  return e;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(100);
  }
}

describe("engine environment", () => {
  test("only allowlisted variables reach the engine", () => {
    const env = engineEnv({
      dataDir: join(dir, "env"),
      password: "pw",
      config: { model: "x/y" },
      source: { PATH: "/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "sk-secret", OPENAI_API_KEY: "sk-2", RANDOM: "1" },
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.RANDOM).toBeUndefined();
    expect(env.XDG_DATA_HOME).toBe(join(dir, "env", "data"));
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("pw");
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: "x/y" });
  });
});

describe("embedded OpenCode engine (real binary)", () => {
  test("starts the bundled binary on a free port and creates a session", async () => {
    const e = engine("basic");
    await e.ensureRunning();
    expect(e.state).toBe("running");
    expect(e.version).toBe("1.19.4");
    const session = await e.createSession({ directory: dir, title: "teste" });
    expect(session).toMatch(/^ses_/);
    expect(await e.sessionExists(session, dir)).toBe(true);
    expect(await e.sessionExists("ses_does_not_exist", dir)).toBe(false);
  }, 60_000);

  test("sessions survive an engine restart (needed to resume after a backend restart)", async () => {
    const e = engine("persist");
    await e.ensureRunning();
    const session = await e.createSession({ directory: dir, title: "persist" });
    await e.restart();
    expect(e.state).toBe("running");
    expect(await e.sessionExists(session, dir)).toBe(true);
  }, 60_000);

  test("accepts and stores per-session permission rules", async () => {
    const e = engine("perm");
    await e.ensureRunning();
    const permission = sessionPermissions(dir, [join(dir, "member")]);
    const session = await e.createSession({ directory: dir, title: "perm", permission });
    const { url, authorization } = e.connection!;
    const res = await fetch(`${url}/session/${session}?directory=${encodeURIComponent(dir)}`, { headers: { authorization } });
    const body = (await res.json()) as { permission?: unknown };
    expect(body.permission).toEqual(permission);
  }, 60_000);

  test("a request without the engine password gets 401", async () => {
    const e = engine("auth");
    await e.ensureRunning();
    const { url, authorization } = e.connection!;
    expect((await fetch(`${url}/path`)).status).toBe(401);
    expect((await fetch(`${url}/path`, { headers: { authorization: "Basic b3BlbmNvZGU6d3Jvbmc=" } })).status).toBe(401);
    expect((await fetch(`${url}/path`, { headers: { authorization } })).status).toBe(200);
  }, 60_000);

  test("an ANTHROPIC_API_KEY exported in the backend does not reach the engine", async () => {
    const e = engine("leak", { sourceEnv: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-should-not-leak" } });
    await e.ensureRunning();
    const { url, authorization } = e.connection!;
    const res = await fetch(`${url}/provider`, { headers: { authorization } });
    const body = (await res.json()) as { connected: string[] };
    expect(body.connected).not.toContain("anthropic");
  }, 60_000);

  test("control: the engine does read ANTHROPIC_API_KEY when it is in its own env", async () => {
    // Without this, the test above could pass only because OpenCode ignores the variable.
    const env = {
      ...engineEnv({ dataDir: join(dir, "leak-control"), password: "pw", config: {} }),
      ANTHROPIC_API_KEY: "sk-ant-control",
    };
    const server = await spawnServer({ binary: bundledBinary().path, env, cwd: dir });
    try {
      const authorization = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;
      const body = (await (await fetch(`${server.url}/provider`, { headers: { authorization } })).json()) as {
        connected: string[];
      };
      expect(body.connected).toContain("anthropic");
    } finally {
      await stopServer(server.proc);
    }
  }, 60_000);

  test("isolates engine state under its data dir", async () => {
    const e = engine("paths");
    await e.ensureRunning();
    const { url, authorization } = e.connection!;
    const paths = (await (await fetch(`${url}/path`, { headers: { authorization } })).json()) as Record<string, string>;
    expect(paths.config).toBe(join(dir, "paths", "config", "opencode"));
    expect(paths.state).toBe(join(dir, "paths", "state", "opencode"));
  }, 60_000);

  test("killing the process triggers a restart and an interrupted event", async () => {
    const e = engine("crash");
    await e.ensureRunning();
    const events: EngineEvent[] = [];
    e.onEvent((ev) => events.push(ev));
    const first = e.pid!;
    process.kill(first, "SIGKILL");
    await waitFor(() => e.state === "running" && e.pid !== undefined && e.pid !== first);
    expect(alive(first)).toBe(false);
    expect(events.some((ev) => ev.kind === "interrupted")).toBe(true);
    expect(events.filter((ev) => ev.kind === "state").map((ev) => (ev as { state: string }).state)).toContain("restarting");
    const { url, authorization } = e.connection!;
    expect((await fetch(`${url}/path`, { headers: { authorization } })).status).toBe(200);
  }, 60_000);

  test("stop leaves no OpenCode process running", async () => {
    const e = engine("stop");
    await e.ensureRunning();
    const pid = e.pid!;
    await e.stop();
    expect(e.state).toBe("stopped");
    expect(alive(pid)).toBe(false);
  }, 60_000);

  test("a binary that cannot start puts the engine in failed with the error", async () => {
    const e = engine("broken", { binary: { path: join(dir, "no-such-opencode"), version: "0" } });
    await expect(e.ensureRunning()).rejects.toThrow();
    expect(e.state).toBe("failed");
    expect(e.lastError).toBeTruthy();
  });
});

describe("event mapping", () => {
  test("maps text deltas, tools, files, idle and errors", () => {
    expect(
      toAgentEvent("/w", {
        id: "1",
        type: "message.part.delta",
        properties: { sessionID: "s", messageID: "m", partID: "p", field: "text", delta: "Olá" },
      } as never),
    ).toEqual({ kind: "text", sessionId: "s", partId: "p", delta: "Olá" });
    expect(
      toAgentEvent("/w", {
        id: "2",
        type: "message.part.updated",
        properties: {
          sessionID: "s",
          time: 0,
          part: { type: "tool", sessionID: "s", callID: "c", tool: "write", state: { status: "completed", title: "proposal.md" } },
        },
      } as never),
    ).toEqual({ kind: "tool", sessionId: "s", callId: "c", tool: "write", status: "completed", title: "proposal.md" });
    expect(toAgentEvent("/w", { id: "3", type: "file.edited", properties: { file: "/w/a.md" } } as never)).toEqual({
      kind: "file",
      directory: "/w",
      path: "/w/a.md",
    });
    expect(toAgentEvent("/w", { id: "4", type: "session.idle", properties: { sessionID: "s" } } as never)).toEqual({
      kind: "idle",
      sessionId: "s",
    });
    expect(
      toAgentEvent("/w", {
        id: "5",
        type: "session.error",
        properties: { sessionID: "s", error: { name: "ProviderAuthError", data: { providerID: "x", message: "bad key" } } },
      } as never),
    ).toEqual({ kind: "error", sessionId: "s", name: "ProviderAuthError", message: "bad key" });
    expect(toAgentEvent("/w", { id: "6", type: "session.status", properties: {} } as never)).toBeUndefined();
  });
});
