import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PromptCall } from "./fake-engine.ts";
import { FakeEngine } from "./fake-engine.ts";

export const ARTIFACTS: Record<string, { path: string; content: string }> = {
  proposal: {
    path: "proposal.md",
    content:
      "# Proposal\n\n## Why\n\nUsuários precisam exportar dados para outras ferramentas com rapidez.\n\n## What Changes\n\n- Exportar CSV.\n\n## Capabilities\n\n### New Capabilities\n- `export`: exportação\n\n## Impact\n\nNenhum.\n",
  },
  specs: {
    path: "specs/export/spec.md",
    content:
      "# Spec Delta\n\n## Purpose\n\nPermite que usuários levem seus dados para fora do produto em formato portátil.\n\n## ADDED Requirements\n\n### Requirement: Exportar CSV\nO sistema SHALL exportar os dados em CSV.\n\n#### Scenario: Exportação\n- **WHEN** o usuário clica em Exportar\n- **THEN** um CSV é baixado\n",
  },
  design: { path: "design.md", content: "# Design\n\n## Context\n\nSimples.\n\n## Decisions\n\n- CSV no servidor.\n" },
  tasks: { path: "tasks.md", content: "# Tasks\n\n## 1. Core\n\n- [ ] 1.1 Implementar exportação\n" },
};

/** A spec delta whose requirement has no scenario: `openspec validate` rejects it. */
export const INVALID_SPEC =
  "# Spec Delta\n\n## Purpose\n\nPermite que usuários levem seus dados para fora do produto em formato portátil.\n\n## ADDED Requirements\n\n### Requirement: Exportar CSV\nO sistema SHALL exportar CSV.\n";

export interface ScriptOptions {
  /** Change folder the agent writes into. */
  changeDir: () => string;
  /** Overrides the content written for an artifact (e.g. an invalid spec). */
  content?: Partial<Record<string, string>>;
  /** Called before finishing; return false to finish without writing. */
  write?: (artifact: string, call: PromptCall) => boolean;
  /** What the decisions checkpoint answers (add-proposal-decisions): a list, or "fail"/"none" to fail or write nothing. */
  decisions?: unknown[] | "fail" | "none" | ((call: PromptCall) => unknown[] | "fail" | "none");
  /** Assumptions the agent lists for an artifact. */
  assumptions?: Partial<Record<string, { text: string; question?: string }[]>>;
  /** Questions the agent asks (and nobody answers) while writing an artifact. */
  questions?: Partial<Record<string, string[]>>;
}

/** The file a prompt asks the agent to write its structured output to, after `marker`. */
function outputFile(text: string, marker: RegExp): string | undefined {
  return marker.exec(text)?.[1];
}

/** Which artifact a prompt asks for, from the prompt headings. */
export function promptArtifact(text: string): string | undefined {
  return /^# (?:Artefato|Ajuste no artefato|Corrigir validação do artefato):? (\w+)/m.exec(text)?.[1];
}

/**
 * A FakeEngine that behaves like an agent: for each prompt it writes the requested
 * artifact into the change folder and then goes idle.
 */
export function scriptedAgent(opts: ScriptOptions): FakeEngine {
  const engine = new FakeEngine();
  engine.connected = ["opencode", "anthropic"];
  engine.onPrompt = async (call, e) => {
    const artifact = promptArtifact(call.text);
    await Bun.sleep(5);
    if (/^# Decisões em aberto/m.test(call.text)) {
      const answer = typeof opts.decisions === "function" ? opts.decisions(call) : (opts.decisions ?? []);
      if (answer === "fail") return e.emit({ kind: "error", sessionId: call.sessionId, name: "ProviderAuthError", message: "sem chave" });
      const file = outputFile(call.text, /Escreva apenas o arquivo `([^`]+)`/);
      if (answer !== "none" && file) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ decisions: answer }));
      }
      return e.emit({ kind: "idle", sessionId: call.sessionId });
    }
    const listed = artifact ? opts.assumptions?.[artifact] : undefined;
    const assumptionsAt = outputFile(call.text, /Liste em `([^`]+)`/);
    if (listed && assumptionsAt) {
      mkdirSync(dirname(assumptionsAt), { recursive: true });
      writeFileSync(assumptionsAt, JSON.stringify({ assumptions: listed }));
    }
    const asked = artifact ? opts.questions?.[artifact] : undefined;
    if (asked?.length) e.emit({ kind: "question", sessionId: call.sessionId, questions: asked });
    if (artifact && (opts.write?.(artifact, call) ?? true)) {
      const spec = ARTIFACTS[artifact]!;
      const file = join(opts.changeDir(), spec.path);
      mkdirSync(dirname(file), { recursive: true });
      const fixed = /^# Corrigir/m.test(call.text);
      const adjusted = /^# Ajuste/m.test(call.text);
      const content = fixed ? spec.content : (opts.content?.[artifact] ?? spec.content);
      writeFileSync(file, adjusted ? `${content}\n<!-- ajustado conforme pedido -->\n` : content);
      e.emit({ kind: "file", directory: call.opts.directory, path: file });
    }
    e.emit({ kind: "text", sessionId: call.sessionId, partId: "p", delta: `pronto: ${artifact}` });
    e.emit({ kind: "idle", sessionId: call.sessionId });
  };
  return engine;
}
