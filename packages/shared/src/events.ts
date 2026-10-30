import type { RunView } from "./engine.ts";
import { z } from "zod";

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("workspace-changed"), workspaceId: z.string() }),
  z.object({ type: z.literal("engine-changed") }),
  /** A run on a change progressed or finished; the payload is the full RunView. */
  z.object({
    type: z.literal("run-updated"),
    workspaceId: z.string(),
    change: z.string(),
    /** Which of the change's sessions ran: planning (default) or apply (add-visual-apply D1). */
    kind: z.enum(["plan", "apply"]).optional(),
    run: z.custom<RunView>(),
  }),
  /** An onboarding job or one of its capabilities changed state. */
  z.object({ type: z.literal("onboarding-changed"), workspaceId: z.string(), jobId: z.string() }),
  /** A workspace's apply environment changed state or printed more output (add-apply-devcontainer). */
  z.object({ type: z.literal("environment-changed"), workspaceId: z.string() }),
  /** The app committed, initialized a repo or changed an identity in the workspace (add-git-commits). */
  z.object({ type: z.literal("git-changed"), workspaceId: z.string() }),
  /** A change's verification progressed, finished, or one of its items changed (add-change-verification). */
  z.object({ type: z.literal("verification-changed"), workspaceId: z.string(), change: z.string() }),
  /** An exploration got a message, an answer, a title, a draft or a new state (add-workspace-explore). */
  z.object({ type: z.literal("exploration-changed"), workspaceId: z.string(), explorationId: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ServerEventType = ServerEvent["type"];
