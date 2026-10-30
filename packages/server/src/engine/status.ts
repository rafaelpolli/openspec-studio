import type { EngineStatus } from "@studio/shared";
import type { EventBus } from "../events.ts";
import type { Engine } from "./engine.ts";

/** The engine's own provider, always reported as connected; it does not count (design D11). */
export const BUILTIN_PROVIDER = "opencode";

/** Translates engine state and providers into what the UI shows (spec: agent-sessions). */
export class EngineStatusService {
  constructor(
    private readonly engine: Engine,
    events: EventBus,
  ) {
    engine.onEvent((event) => {
      if (event.kind === "state" || event.kind === "interrupted") events.publish({ type: "engine-changed" });
    });
  }

  async status(): Promise<EngineStatus> {
    const version = this.engine.version;
    switch (this.engine.state) {
      case "stopped":
      case "starting":
      case "restarting":
        return { availability: "iniciando", version };
      case "failed":
        return { availability: "falhou", version, message: this.engine.lastError ?? "o motor não iniciou" };
      case "running": {
        const connected = await this.engine.connectedProviders().catch(() => undefined);
        if (connected === undefined) {
          return { availability: "falhou", version, message: "o motor não respondeu" };
        }
        const configured = connected.filter((p) => p !== BUILTIN_PROVIDER);
        return configured.length > 0
          ? { availability: "disponivel", version }
          : { availability: "sem_provedor", version, message: "nenhum provedor de LLM configurado" };
      }
    }
  }

  /** Retries a failed engine; the outcome is reported through status and events. */
  async retry(): Promise<EngineStatus> {
    await this.engine.restart().catch(() => {});
    return this.status();
  }
}
