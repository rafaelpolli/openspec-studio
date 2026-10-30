import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { EventBus } from "./events.ts";
import { createToken } from "./security.ts";

const dir = mkdtempSync(join(tmpdir(), "studio-ui-"));
const dist = join(dir, "dist");
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), '<meta name="studio-token" content="%STUDIO_TOKEN%" />');
writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
writeFileSync(join(dir, "secret.txt"), "não deveria sair");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const token = createToken();
const app = createApp({
  token,
  allowedOrigins: [],
  events: new EventBus(),
  ui: { dir: dist, allowedHosts: ["127.0.0.1:4317", "localhost:4317"] },
});
const get = (path: string, host = "127.0.0.1:4317") => app.request(`http://${host}${path}`, { headers: { host } });

describe("built UI (9.1)", () => {
  test("index.html carries this run's token, also for client-side routes", async () => {
    for (const path of ["/", "/w/abc/onboarding", "/providers"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`<meta name="studio-token" content="${token}" />`);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("serves assets, never files outside the build", async () => {
    expect(await (await get("/assets/app.js")).text()).toBe("console.log(1)");
    const escape = await get("/../secret.txt");
    expect(await escape.text()).not.toContain("não deveria sair");
    const encoded = await get("/%2e%2e/secret.txt");
    expect(await encoded.text()).not.toContain("não deveria sair");
  });

  test("refuses another Host (DNS rebinding) and keeps the API protected", async () => {
    const res = await get("/", "evil.example:4317");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(token);
    expect((await get("/api/health")).status).toBe(403);
    expect((await get("/api/nao-existe")).status).toBe(403);
  });
});
