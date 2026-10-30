import type { Database } from "bun:sqlite";
import type { OauthStart, ProvidersResponse, ProviderView } from "@studio/shared";
import type { OpencodeEngine } from "./opencode.ts";
import type { AgentRunner } from "./runner.ts";
import { BUILTIN_PROVIDER } from "./status.ts";

export class ProviderInputError extends Error {
  override readonly name = "ProviderInputError";
}

const DEFAULT_MODEL = "default_model";

/** Provider administration needed by the Providers screen (design D11). */
export type ProviderAdmin = Pick<
  OpencodeEngine,
  "providerCatalog" | "setApiKey" | "removeAuth" | "oauthAuthorize" | "oauthCallback" | "restart"
>;

/**
 * Configures LLM providers through the embedded engine. Credentials stay in the engine's
 * isolated data dir and are never returned: responses are built field by field.
 */
export class ProviderService {
  constructor(
    private readonly engine: ProviderAdmin,
    private readonly db: Database,
    private readonly runner: Pick<AgentRunner, "activeCount">,
  ) {}

  defaultModel(): string | null {
    return (
      this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(DEFAULT_MODEL)
        ?.value ?? null
    );
  }

  /** OpenCode config injected when the engine starts. */
  engineConfig(): Record<string, unknown> {
    const model = this.defaultModel();
    return model ? { model } : {};
  }

  async list(): Promise<ProvidersResponse> {
    const catalog = await this.engine.providerCatalog();
    const connected = new Set(catalog.connected.filter((id) => id !== BUILTIN_PROVIDER));
    const providers: ProviderView[] = catalog.all
      .filter((p) => p.id !== BUILTIN_PROVIDER)
      .map((p) => {
        const configured = connected.has(p.id);
        const methods = (catalog.methods[p.id] ?? [{ type: "api" as const, label: "Chave de API" }]).map((m, index) => ({
          index,
          type: m.type,
          label: m.label,
        }));
        return {
          id: p.id,
          name: p.name,
          configured,
          methods,
          models: configured
            ? Object.values(p.models)
                .map((m) => ({ id: m.id, name: m.name }))
                .sort((a, b) => a.name.localeCompare(b.name))
            : [],
        };
      })
      .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
    return { providers, defaultModel: this.defaultModel() };
  }

  async setApiKey(providerId: string, key: string): Promise<void> {
    if (!key.trim()) throw new ProviderInputError("a chave de API não pode ser vazia");
    await this.#assertKnown(providerId);
    await this.engine.setApiKey(providerId, key.trim());
  }

  /** Removes the credential; the engine only drops it after a restart (spike 1.5). */
  async remove(providerId: string): Promise<{ applied: boolean }> {
    await this.#assertKnown(providerId);
    await this.engine.removeAuth(providerId);
    if (this.defaultModel()?.startsWith(`${providerId}/`)) {
      this.db.query("DELETE FROM settings WHERE key = ?").run(DEFAULT_MODEL);
    }
    return this.#restartIfIdle();
  }

  async oauthStart(providerId: string, method: number, inputs?: Record<string, string>): Promise<OauthStart> {
    await this.#assertKnown(providerId);
    const auth = await this.engine.oauthAuthorize(providerId, method, inputs);
    return { url: auth.url, method: auth.method, instructions: auth.instructions };
  }

  async oauthFinish(providerId: string, method: number, code?: string): Promise<void> {
    const ok = await this.engine.oauthCallback(providerId, method, code);
    if (!ok) throw new ProviderInputError("a autorização OAuth não foi concluída");
  }

  /** Sets "providerID/modelID" as the default model for new sessions. */
  async setDefaultModel(model: string): Promise<{ applied: boolean }> {
    const [providerId, ...rest] = model.split("/");
    const modelId = rest.join("/");
    const { providers } = await this.list();
    const provider = providers.find((p) => p.id === providerId);
    if (!provider?.configured || !provider.models.some((m) => m.id === modelId)) {
      throw new ProviderInputError(`modelo indisponível: ${model}`);
    }
    this.db
      .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(DEFAULT_MODEL, model);
    return this.#restartIfIdle();
  }

  /** Restarts now when no agent is working; otherwise the change applies on the next restart. */
  async #restartIfIdle(): Promise<{ applied: boolean }> {
    if (this.runner.activeCount > 0) return { applied: false };
    await this.engine.restart();
    return { applied: true };
  }

  async #assertKnown(providerId: string): Promise<void> {
    const catalog = await this.engine.providerCatalog();
    if (!catalog.all.some((p) => p.id === providerId)) throw new ProviderInputError(`provedor desconhecido: ${providerId}`);
  }
}
