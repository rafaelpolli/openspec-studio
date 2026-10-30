import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Hono } from "hono";

const TOKEN_PLACEHOLDER = "%STUDIO_TOKEN%";

/** True when the built UI exists at `dir` (after `bun run build`). */
export function hasBuiltUi(dir: string): boolean {
  return existsSync(join(dir, "index.html"));
}

/**
 * Serves the built UI with this run's token injected into index.html (design D2). The
 * page carries the token, so it is only served when the Host header names this server:
 * a DNS-rebinding page under another host name cannot read it.
 */
export function uiRoutes(opts: { dir: string; token: string; allowedHosts: readonly string[] }): Hono {
  const r = new Hono();
  const root = resolve(opts.dir);
  const index = readFileSync(join(root, "index.html"), "utf8").replace(TOKEN_PLACEHOLDER, opts.token);

  r.get("*", (c) => {
    if (!opts.allowedHosts.includes(c.req.header("host") ?? "")) return c.text("host not allowed", 403);
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    if (path.startsWith("/api/")) return c.notFound();
    const file = resolve(root, `.${path}`);
    const rel = relative(root, file);
    const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    if (inside && rel !== "index.html" && existsSync(file) && statSync(file).isFile()) {
      return new Response(Bun.file(file));
    }
    // Client-side routes (/w/:id, /providers, ...) all get the app shell.
    return c.html(index, 200, { "cache-control": "no-store" });
  });
  return r;
}
