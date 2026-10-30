export * from "./api.ts";
export * from "./events.ts";
export * from "./openspec.ts";
export * from "./engine.ts";
export * from "./onboarding.ts";
export * from "./apply.ts";

export const APP_NAME = "openspec-studio";

/** Header carrying the per-run token that protects the local API. */
export const TOKEN_HEADER = "x-studio-token";
/** Query parameter alternative, for clients that cannot set headers (EventSource). */
export const TOKEN_QUERY = "token";
export * from "./git.ts";
export * from "./verification.ts";
export * from "./decisions.ts";
export * from "./exploration.ts";
