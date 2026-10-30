import { afterAll, describe, expect, test } from "bun:test";
import { ServerEvent, TOKEN_HEADER } from "@studio/shared";
import { createApp } from "./app.ts";
import { EventBus } from "./events.ts";
import { createToken } from "./security.ts";

const token = createToken();
const events = new EventBus();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: createApp({ token, allowedOrigins: [], events }).fetch,
});
afterAll(() => server.stop(true));

/** Reads SSE frames from a response body and yields each parsed `data:` payload. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield ServerEvent.parse(JSON.parse(data));
    }
  }
}

describe("SSE events", () => {
  test("a published event reaches a connected client", async () => {
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      headers: { [TOKEN_HEADER]: token },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const it = frames(res.body!);
    expect((await it.next()).value).toEqual({ type: "hello" });
    expect(events.size).toBe(1);

    events.publish({ type: "workspace-changed", workspaceId: "ws-1" });
    expect((await it.next()).value).toEqual({ type: "workspace-changed", workspaceId: "ws-1" });

    abort.abort();
  });

  test("the events stream requires the token", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`);
    expect(res.status).toBe(403);
  });
});
