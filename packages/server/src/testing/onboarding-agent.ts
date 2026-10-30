import type { CapabilityDraft } from "@studio/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PromptCall } from "./fake-engine.ts";
import { FakeEngine } from "./fake-engine.ts";

export interface OnboardingScript {
  /** What the discovery writes; a string is written verbatim (e.g. invalid JSON). */
  discovery?: { capabilities: CapabilityDraft[] } | string | ((memberNames: string[]) => { capabilities: CapabilityDraft[] });
  /** Capabilities whose baseline session fails with a provider error. */
  fail?: Set<string>;
  /** Capabilities whose session never finishes on its own (until aborted). */
  hang?: Set<string>;
  /** Capabilities whose spec is written without a scenario (fails validation). */
  invalid?: Set<string>;
  /** Capabilities whose session also writes a tasks.md (a baseline must not have one). */
  tasks?: Set<string>;
  /** Capabilities whose spec is written without a ## Purpose section. */
  noPurpose?: Set<string>;
  /** Simulated work per prompt, so concurrency can be observed. */
  delayMs?: number;
}

export function baselineFiles(cap: string, opts: { invalid?: boolean; adjusted?: boolean } = {}) {
  const scenario = opts.invalid ? "" : "\n#### Scenario: Acesso negado\n- **WHEN** a senha está errada\n- **THEN** o acesso é negado\n";
  const second = `\n### Requirement: Registrar tentativas\nO sistema SHALL registrar cada tentativa de ${cap}.\n\n#### Scenario: Tentativa registrada\n- **WHEN** alguém tenta\n- **THEN** a tentativa fica registrada\n`;
  return {
    "proposal.md": `# Proposal\n\n## Why\n\nDocumentar como ${cap} se comporta hoje, antes de mudar qualquer coisa nela.\n\n## What Changes\n\n- Baseline de ${cap}.\n\n## Capabilities\n\n### New Capabilities\n- \`${cap}\`: ${cap}\n\n## Impact\n\nNenhum.\n`,
    [`specs/${cap}/spec.md`]: `# Spec Delta\n\n## Purpose\n\nDescreve como ${cap} funciona hoje no sistema existente.\n\n## ADDED Requirements\n\n### Requirement: Validar credenciais\nO sistema SHALL recusar credenciais inválidas em ${cap}.\n${scenario}${second}`,
    "design.md": `# Design\n\n## Context\n\nComo ${cap} funciona hoje.${opts.adjusted ? "\n\nAjustado conforme pedido." : ""}\n\n## Evidências\n\n| Requisito | Evidência | Fonte |\n|---|---|---|\n| Validar credenciais | \`api/src/${cap}.ts:12\`, \`api/test/${cap}.test.ts:5\` | testado |\n| Registrar tentativas | \`api/src/${cap}.ts:40\` | inferido |\n`,
  };
}

/** Extracts a backticked path that follows `marker` in a prompt. */
function pathAfter(text: string, marker: string): string | undefined {
  const i = text.indexOf(marker);
  return i < 0 ? undefined : /`([^`]+)`/.exec(text.slice(i + marker.length))?.[1];
}

/** A FakeEngine that plays the discovery and baseline sessions of the onboarding. */
export function onboardingAgent(script: OnboardingScript = {}) {
  const engine = new FakeEngine();
  engine.connected = ["opencode", "anthropic"];
  let active = 0;
  const stats = { maxActive: 0, prompts: [] as string[] };
  const hanging = new Map<string, () => void>();

  engine.abort = async (sessionId: string) => {
    engine.aborted.push(sessionId);
    hanging.get(sessionId)?.();
  };

  engine.onPrompt = async (call: PromptCall, e) => {
    const finish = (error?: string) => {
      active--;
      if (error) e.emit({ kind: "error", sessionId: call.sessionId, name: "ProviderAuthError", message: error });
      else e.emit({ kind: "idle", sessionId: call.sessionId });
    };
    active++;
    stats.maxActive = Math.max(stats.maxActive, active);
    // Settle asynchronously, as the real engine does after accepting the prompt.
    void (async () => {
      await Bun.sleep(script.delayMs ?? 5);
      const text = call.text;
      if (text.startsWith("# Descoberta de capacidades")) {
        stats.prompts.push("discovery");
        const out = pathAfter(text, "Escreva apenas o arquivo")!;
        const members = [...text.matchAll(/^- ([\w.-]+): `/gm)].map((m) => m[1]!);
        const given = script.discovery ?? { capabilities: [{ name: "auth", description: "Login.", locations: [] }] };
        const d = typeof given === "function" ? given(members) : given;
        writeFileSync(out, typeof d === "string" ? d : JSON.stringify(d));
        return finish();
      }
      const baseline = /^# Baseline: ([a-z0-9-]+)/.exec(text)?.[1];
      const adjust = /^# Ajuste no artefato baseline ([a-z0-9-]+)/.exec(text)?.[1];
      const cap = baseline ?? adjust;
      if (!cap) return finish();
      stats.prompts.push(`${adjust ? "adjust" : "baseline"}:${cap}`);
      if (script.hang?.has(cap) && !adjust) {
        hanging.set(call.sessionId, () => {
          active--;
          e.emit({ kind: "error", sessionId: call.sessionId, name: "MessageAbortedError", message: "aborted" });
        });
        return;
      }
      if (script.fail?.has(cap) && !adjust) return finish("invalid api key");
      const dir = baseline
        ? pathAfter(text, "Todos dentro de")!
        : dirname(pathAfter(text, "## Arquivos a reescrever")!);
      const files: Record<string, string> = baselineFiles(cap, { invalid: script.invalid?.has(cap) ?? false, adjusted: !!adjust });
      if (script.noPurpose?.has(cap) && !adjust) {
        const spec = `specs/${cap}/spec.md`;
        files[spec] = files[spec]!.replace(/## Purpose\n\n.*\n\n/, "");
      }
      if (script.tasks?.has(cap)) files["tasks.md"] = "# Tasks\n\nBaseline: não há implementação.\n";
      for (const [rel, content] of Object.entries(files)) {
        const file = join(dir, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        e.emit({ kind: "file", directory: call.opts.directory, path: file });
      }
      finish();
    })();
  };
  return { engine, stats };
}
