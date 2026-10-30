// Backend entry point for E2E tests: the real app with a scripted agent instead of OpenCode.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../server.ts";
import { onboardingAgent } from "./onboarding-agent.ts";
import { scriptedAgent } from "./scripted-agent.ts";

let changeDir = "";
// A change described "com decisões" gets one open decision and an assumption in its proposal
// (add-proposal-decisions); the others get none, as before.
const agent = scriptedAgent({
  changeDir: () => changeDir,
  decisions: (call) =>
    /com decisões/.test(call.text)
      ? [{ id: "campos", question: "Quais campos entram no CSV?", options: [{ label: "Todos" }, { label: "Só nome e e-mail" }], recommended: 1 }]
      : [],
  assumptions: { proposal: [{ text: "o export roda em segundo plano" }] },
});
const exploring = new Set<string>();
/** The scripted exploration agent: answers echo the message, the first one writes a title, the draft is fixed. */
async function explore(sessionId: string, text: string): Promise<void> {
  await Bun.sleep(5);
  const draftFile = /escreva apenas o arquivo `([^`]+)`/.exec(text)?.[1];
  if (/^# Virar change/.test(text) && draftFile) {
    writeFileSync(
      draftFile,
      JSON.stringify({
        name: "add-export-csv",
        description: "Exportar os dados do usuário em CSV, a partir da tela de perfil.",
        decisions: [{ question: "Formato do arquivo", answer: "CSV" }],
      }),
    );
    return agent.emit({ kind: "idle", sessionId });
  }
  const titleFile = /escreva em `([^`]+)` um título curto/.exec(text)?.[1];
  if (titleFile) writeFileSync(titleFile, "Exportar dados\n");
  const message = text.split("\n").at(-1) ?? "";
  agent.emit({ kind: "text", sessionId, partId: `x${agent.prompts.length}`, delta: `Resposta do agente: ${message}` });
  agent.emit({ kind: "idle", sessionId });
}
// Every prompt is logged, so a browser test can check what the agent was asked.
const log = join(process.env.STUDIO_DATA_DIR ?? ".", "prompts.log");
const prompt = agent.prompt.bind(agent);
// Onboarding prompts (discovery, baselines) are played by the onboarding script.
const onboarding = onboardingAgent({
  discovery: (members) => ({
    capabilities: ["auth", "billing", "legacy-reports"].map((name) => ({
      name,
      description: `Capacidade ${name}.`,
      locations: members.map((member) => ({ member, path: "src" })),
    })),
  }),
}).engine.onPrompt!;
// Each prompt names the change folder it writes into; point the agent at it.
agent.prompt = async (sessionId, text, opts) => {
  if (/^# (Descoberta|Baseline|Ajuste no artefato baseline)/.test(text)) {
    agent.prompts.push({ sessionId, text, opts });
    return onboarding({ sessionId, text, opts }, agent);
  }
  appendFileSync(log, `${text}\n---\n`);
  // Explorations (add-workspace-explore): the first prompt opens the session; later ones are plain text.
  if (/^# Exploração\n/.test(text) || exploring.has(sessionId)) {
    exploring.add(sessionId);
    agent.prompts.push({ sessionId, text, opts });
    return explore(sessionId, text);
  }
  const match = /`([^`]+\/openspec\/changes\/[^/`]+)\//.exec(text);
  if (match) changeDir = match[1]!;
  else changeDir = join(opts.directory, "openspec/changes", /change `([^`]+)`/.exec(text)?.[1] ?? "");
  return prompt(sessionId, text, opts);
};

await startServer({ port: Number(process.env.STUDIO_PORT ?? 0), engine: agent });
