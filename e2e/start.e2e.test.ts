import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";

const REPO = resolve(import.meta.dir, "..");
let dir: string;
let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
let url = "";
let browser: Browser;

/** PIDs of processes whose environment points at this test's data dir. */
function processesUsing(path: string): number[] {
  const out = Bun.spawnSync(["pgrep", "-f", "opencode serve|src/index.ts"]).stdout.toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, "utf8").includes(path);
      } catch {
        return false;
      }
    });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "studio-start-"));
  // `setsid` puts `bun run start` and everything it spawns in one process group.
  proc = Bun.spawn(["setsid", "bun", "run", "start"], {
    cwd: REPO,
    env: {
      ...process.env,
      STUDIO_DATA_DIR: join(dir, ".studio"),
      XDG_DATA_HOME: join(dir, ".xdg"),
      STUDIO_PORT: "0",
      NO_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let seen = "";
  while (!/open (http:\/\/127\.0\.0\.1:\d+) in your browser/.test(seen)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`start exited early:\n${seen}`);
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  url = /open (http:\/\/127\.0\.0\.1:\d+) in your browser/.exec(seen)![1]!;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (proc) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await proc.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("9.1 bun run start", () => {
  test("a single command serves the UI at http://127.0.0.1:<port>, already holding the token", async () => {
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByRole("heading", { name: "Workspaces" }).waitFor({ timeout: 20_000 });
    // The page talks to the API with the injected token: the list loads instead of a 403.
    await page.getByText("Nenhum workspace").or(page.getByRole("link", { name: "Novo workspace" })).first().waitFor();
    const token = await page.locator('meta[name="studio-token"]').getAttribute("content");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await fetch(`${url}/api/workspaces`)).status).toBe(403);
    expect((await fetch(`${url}/api/workspaces`, { headers: { "x-studio-token": token! } })).status).toBe(200);
    await page.close();
  }, 60_000);

  test("stopping it leaves no backend or engine process behind", async () => {
    process.kill(-proc.pid, "SIGTERM");
    await proc.exited;
    await Bun.sleep(500);
    expect(processesUsing(dir)).toEqual([]);
  }, 30_000);
});
