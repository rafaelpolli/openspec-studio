import { TOKEN_HEADER, TOKEN_QUERY, type ApiError } from "@studio/shared";
import type { MiddlewareHandler } from "hono";

export function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function forbidden(message: string): ApiError {
  return { error: { code: "forbidden", message } };
}

/**
 * Rejects requests from other origins and requests without the per-run token.
 * Browsers always send Origin on cross-origin requests, so a missing Origin is
 * treated as a same-origin or non-browser client and only the token decides.
 */
export function guard(opts: { token: string; allowedOrigins: readonly string[] }): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !opts.allowedOrigins.includes(origin)) {
      return c.json(forbidden("origin not allowed"), 403);
    }
    const supplied = c.req.header(TOKEN_HEADER) ?? c.req.query(TOKEN_QUERY) ?? "";
    if (!constantTimeEqual(supplied, opts.token)) {
      return c.json(forbidden("missing or invalid token"), 403);
    }
    await next();
  };
}
