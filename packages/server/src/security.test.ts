import { describe, expect, test } from "bun:test";
import { TOKEN_HEADER } from "@studio/shared";
import { createApp } from "./app.ts";
import { EventBus } from "./events.ts";
import { createToken } from "./security.ts";

const ORIGIN = "http://127.0.0.1:4317";
const token = createToken();
const app = createApp({ token, allowedOrigins: [ORIGIN], events: new EventBus() });

const get = (headers: Record<string, string>, path = "/api/health") =>
  app.request(path, { headers });

describe("API guard", () => {
  test("accepts the token from an allowed origin", async () => {
    const res = await get({ [TOKEN_HEADER]: token, origin: ORIGIN });
    expect(res.status).toBe(200);
  });

  test("accepts the token without an Origin header (same-origin or non-browser)", async () => {
    expect((await get({ [TOKEN_HEADER]: token })).status).toBe(200);
  });

  test("rejects a request without a token with 403", async () => {
    const res = await get({ origin: ORIGIN });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: "missing or invalid token" },
    });
  });

  test("rejects a wrong token with 403", async () => {
    expect((await get({ [TOKEN_HEADER]: createToken() })).status).toBe(403);
  });

  test("rejects another origin with 403 even with a valid token", async () => {
    const res = await get({ [TOKEN_HEADER]: token, origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  test("accepts the token as a query parameter", async () => {
    expect((await get({}, `/api/health?token=${token}`)).status).toBe(200);
  });

  test("tokens are random per run", () => {
    expect(createToken()).not.toBe(createToken());
  });
});
