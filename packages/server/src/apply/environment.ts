import type { Database } from "bun:sqlite";
import type { DevcontainerOption, EnvironmentConfig, EnvironmentMode, EnvironmentSettings, StockImage, Workspace } from "@studio/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Stock images for projects without a devcontainer.json (D3). */
export const STOCK_IMAGES: StockImage[] = [
  { id: "base", label: "Genérica (Debian)", image: "mcr.microsoft.com/devcontainers/base:debian" },
  { id: "node", label: "Node.js 22", image: "mcr.microsoft.com/devcontainers/typescript-node:22" },
  { id: "python", label: "Python 3.12", image: "mcr.microsoft.com/devcontainers/python:3.12" },
];

const DEFAULT_IDLE_MINUTES = 30;
const settingKey = (workspaceId: string) => `apply-environment:${workspaceId}`;

export class EnvironmentInputError extends Error {
  override readonly name = "EnvironmentInputError";
}

/** The `.devcontainer/devcontainer.json` files in the root and the members, root first. */
export function findDevcontainers(ws: Workspace): DevcontainerOption[] {
  const places = [{ member: ws.name, path: ws.rootPath }, ...ws.members.map((m) => ({ member: m.name, path: m.path }))];
  const seen = new Set<string>();
  const out: DevcontainerOption[] = [];
  for (const p of places) {
    const file = join(p.path, ".devcontainer", "devcontainer.json");
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    out.push({ member: p.member, path: file });
  }
  return out;
}

/**
 * Each workspace's apply environment (add-apply-devcontainer D7). A workspace with nothing
 * stored runs on the machine (`local`), which is how every workspace worked before.
 */
export class EnvironmentStore {
  constructor(private readonly db: Database) {}

  get(workspaceId: string): EnvironmentConfig {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(settingKey(workspaceId));
    if (!row) return { mode: "local", idleMinutes: DEFAULT_IDLE_MINUTES };
    return JSON.parse(row.value) as EnvironmentConfig;
  }

  settings(ws: Workspace): EnvironmentSettings {
    const devcontainers = findDevcontainers(ws);
    return {
      config: this.get(ws.id),
      devcontainers,
      images: STOCK_IMAGES,
      ...(devcontainers[0] ? { suggested: `devcontainer:${devcontainers[0].path}` as EnvironmentMode } : {}),
    };
  }

  set(ws: Workspace, config: EnvironmentConfig): EnvironmentConfig {
    if (config.mode.startsWith("devcontainer:")) {
      const path = config.mode.slice("devcontainer:".length);
      if (!findDevcontainers(ws).some((d) => d.path === path)) {
        throw new EnvironmentInputError("esse devcontainer.json não está na raiz nem nos membros do workspace");
      }
    } else if (config.mode.startsWith("imagem:")) {
      const id = config.mode.slice("imagem:".length);
      if (!STOCK_IMAGES.some((i) => i.id === id)) throw new EnvironmentInputError(`imagem padrão desconhecida: ${id}`);
    } else if (config.mode !== "local") {
      throw new EnvironmentInputError(`modo de ambiente inválido: ${config.mode}`);
    }
    if (!Number.isInteger(config.idleMinutes) || config.idleMinutes < 1) {
      throw new EnvironmentInputError("o tempo de ociosidade deve ser um número inteiro de minutos, a partir de 1");
    }
    const value: EnvironmentConfig = { mode: config.mode, idleMinutes: config.idleMinutes };
    this.db
      .query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(settingKey(ws.id), JSON.stringify(value));
    return value;
  }
}
