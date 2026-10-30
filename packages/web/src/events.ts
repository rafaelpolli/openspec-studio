import { ServerEvent, TOKEN_QUERY } from "@studio/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { readToken } from "./api.ts";
import { applyKey, environmentKey, explorationsKey, gitKey, onboardingKey, runKey } from "./queries.ts";

/** Subscribes to backend events and invalidates the affected queries. */
export function useServerEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource(`/api/events?${TOKEN_QUERY}=${encodeURIComponent(readToken())}`);
    source.addEventListener("workspace-changed", (msg) => {
      const event = ServerEvent.safeParse(JSON.parse((msg as MessageEvent<string>).data));
      if (event.success && event.data.type === "workspace-changed") {
        void client.invalidateQueries({ queryKey: ["workspace", event.data.workspaceId] });
      }
    });
    source.addEventListener("run-updated", (msg) => {
      const event = ServerEvent.safeParse(JSON.parse((msg as MessageEvent<string>).data));
      if (event.success && event.data.type === "run-updated") {
        if (event.data.kind === "apply") {
          void client.invalidateQueries({ queryKey: applyKey(event.data.workspaceId, event.data.change) });
          return;
        }
        // The payload is the whole run, so it replaces the cached view without a refetch.
        client.setQueryData(runKey(event.data.workspaceId, event.data.change), event.data.run);
        if (event.data.run.status !== "rodando") {
          // A finished run may have written artifacts: refresh the change's proposal and files.
          void client.invalidateQueries({ queryKey: ["workspace", event.data.workspaceId, "change", event.data.change] });
        }
      }
    });
    source.addEventListener("onboarding-changed", (msg) => {
      const event = ServerEvent.safeParse(JSON.parse((msg as MessageEvent<string>).data));
      if (event.success && event.data.type === "onboarding-changed") {
        void client.invalidateQueries({ queryKey: onboardingKey(event.data.workspaceId) });
      }
    });
    source.addEventListener("environment-changed", (msg) => {
      const event = ServerEvent.safeParse(JSON.parse((msg as MessageEvent<string>).data));
      if (event.success && event.data.type === "environment-changed") {
        void client.invalidateQueries({ queryKey: environmentKey(event.data.workspaceId) });
      }
    });
    source.addEventListener("git-changed", (msg) => {
      const event = ServerEvent.safeParse(JSON.parse((msg as MessageEvent<string>).data));
      if (event.success && event.data.type === "git-changed") {
        void client.invalidateQueries({ queryKey: gitKey(event.data.workspaceId) });
      }
    });
    source.addEventListener("verification-changed", (msg) => {
      const event = ServerEvent.safeParse(JSON.parse((msg as MessageEvent<string>).data));
      if (event.success && event.data.type === "verification-changed") {
        // The verification, and the change's tasks.md and apply state that it may have touched.
        void client.invalidateQueries({ queryKey: ["workspace", event.data.workspaceId, "change", event.data.change] });
        void client.invalidateQueries({ queryKey: gitKey(event.data.workspaceId) });
      }
    });
    source.addEventListener("exploration-changed", (msg) => {
      const event = ServerEvent.safeParse(JSON.parse((msg as MessageEvent<string>).data));
      if (event.success && event.data.type === "exploration-changed") {
        void client.invalidateQueries({ queryKey: explorationsKey(event.data.workspaceId) });
      }
    });
    source.addEventListener("engine-changed", () => {
      void client.invalidateQueries({ queryKey: ["engine"] });
    });
    return () => source.close();
  }, [client]);
}
