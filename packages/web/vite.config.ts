import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const RUN_FILE = join(
  process.env.STUDIO_DATA_DIR ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "openspec-studio"),
  "run.json",
);

/** Reads the running backend's URL and token from the run file it writes on start. */
function backendRun(): { url: string; token: string } {
  try {
    return JSON.parse(readFileSync(RUN_FILE, "utf8"));
  } catch {
    throw new Error("backend is not running: start it with `bun run dev` at the repo root");
  }
}

/** Waits for the backend to start, so both can be launched together. */
async function waitForBackend(timeoutMs = 15_000): Promise<{ url: string; token: string }> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(RUN_FILE)) {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return backendRun();
}

/** Injects the backend token into index.html on every request, so a backend restart is picked up. */
function injectToken(): Plugin {
  return {
    name: "studio-token",
    transformIndexHtml: (html) => html.replace("%STUDIO_TOKEN%", backendRun().token),
  };
}

export default defineConfig(async ({ command }) => {
  if (command !== "serve") return { plugins: [react()] };
  const backend = await waitForBackend();
  return {
    plugins: [react(), injectToken()],
    server: {
      host: "127.0.0.1",
      port: Number(process.env.STUDIO_WEB_PORT ?? 5173),
      strictPort: true,
      proxy: { "/api": { target: backend.url, changeOrigin: false } },
    },
  };
});
